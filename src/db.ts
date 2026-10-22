import pg from 'pg';
import type { Logger } from './logger.js';

export type Db = pg.Pool;
export type Client = pg.PoolClient;

/**
 * Yerel veritabanı bağlantı havuzu (en çok 5). Kopan bağlantı havuzdan
 * atılır, sonraki sorgu yenisini açar. Uzun sorgu/kilit beklemesi ve açık
 * unutulmuş transaction sınırlanır (ajan takılı kalmasın).
 */
export function createDb(url: string, log: Logger): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    application_name: 'stocktrack-sync',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 120_000,
    idle_in_transaction_session_timeout: 300_000,
  });
  pool.on('error', (err) => log.warn('db.idle_error', `Veritabanı bağlantısı koptu: ${err.message}`));
  return pool;
}

/**
 * Merkezden gelen veriyi yazan transaction: `stocktrack.sync_origin =
 * 'upstream'` ayarlı, böylece yazımlar yerel değişiklik günlüğüne girmez.
 */
export async function upstreamTx<T>(db: Db, fn: (c: Client) => Promise<T>): Promise<T> {
  return tx(db, async (c) => {
    await c.query(`SET LOCAL stocktrack.sync_origin = 'upstream'`);
    return fn(c);
  });
}

export async function tx<T>(db: Db, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await db.connect();
  let broken = false;
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    c.release(broken);
  }
}

export interface ReplicaState {
  upstream_server_id: string | null;
  last_seq: string | null;
  rebased_seq: string | null;
  snapshot_at: Date | null;
}

export async function readState(db: Db | Client): Promise<ReplicaState> {
  const { rows } = await db.query<ReplicaState>(
    `SELECT upstream_server_id::text, last_seq::text, rebased_seq::text, snapshot_at
       FROM replica_state WHERE id = 1`,
  );
  return rows[0] ?? { upstream_server_id: null, last_seq: null, rebased_seq: null, snapshot_at: null };
}

/** replica_state alanlarını yazar (satır yoksa açar). Alan adları koddan gelir. */
export async function writeState(db: Db | Client, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  for (const k of keys) if (!/^[a-z_]+$/.test(k)) throw new Error(`geçersiz alan: ${k}`);
  const cols = keys.map((k) => `"${k}"`).join(', ');
  const vals = keys.map((_, i) => `$${i + 1}`).join(', ');
  const set = keys.map((k) => `"${k}" = EXCLUDED."${k}"`).join(', ');
  await db.query(
    `INSERT INTO replica_state (id, ${cols}, updated_at) VALUES (1, ${vals}, now())
     ON CONFLICT (id) DO UPDATE SET ${set}, updated_at = now()`,
    keys.map((k) => fields[k]),
  );
}

/** Giden kutusundaki durum sayıları. */
export async function outboxCounts(db: Db | Client): Promise<Record<string, number>> {
  const { rows } = await db.query<{ state: string; n: number }>(
    `SELECT state, COUNT(*)::int AS n FROM replica_outbox
      WHERE state IN ('executing', 'pending', 'pushing', 'rejected', 'uncertain') GROUP BY state`,
  );
  return Object.fromEntries(rows.map((r) => [r.state, r.n]));
}

/** Gönderilmeyi bekleyen (yerel etkisi henüz merkezde olmayan) işlem var mı? */
export async function hasUnsent(db: Db | Client): Promise<boolean> {
  const { rows } = await db.query<{ n: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM replica_outbox WHERE state IN ('executing', 'pending', 'pushing')) AS n`,
  );
  return rows[0]!.n;
}

export class NotQuietError extends Error {
  constructor() {
    super('Eşitleme sırasında yeni yerel işlem geldi; bir sonraki turda yeniden denenecek.');
  }
}

/**
 * Merkez verisi yazan transaction'ın COMMIT'inden hemen önce: gönderilmemiş
 * işlem varsa (duraklatma bir şekilde aşıldıysa) yazılanlar geri alınır —
 * bekleyen işlemin yerel etkisi merkezdeki eski halle ezilmesin.
 */
export async function assertQuiet(c: Client): Promise<void> {
  if (await hasUnsent(c)) throw new NotQuietError();
}

const LOCK_SQL = `SELECT pg_try_advisory_lock(hashtext('stocktrack.sync_agent')) AS ok`;

/**
 * Tek ajan kuralı: oturum boyu süren danışma kilidi. Kilidin bağlantısı
 * koparsa kilit de gider; `held` false olur ve döngü yeniden almayı dener.
 */
export class AgentLock {
  private client: Client | null = null;
  held = false;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
  ) {}

  /** true: alındı · false: başka bir ajan tutuyor. Veritabanı yoksa hata fırlatır. */
  async acquire(): Promise<boolean> {
    if (this.held) return true;
    const c = await this.db.connect();
    let ok = false;
    try {
      ok = (await c.query<{ ok: boolean }>(LOCK_SQL)).rows[0]!.ok;
    } finally {
      if (!ok) c.release();
    }
    if (!ok) return false;
    c.on('error', (err) => {
      this.log.warn('lock.lost', `Ajan kilidinin bağlantısı koptu: ${err.message}`);
      this.held = false;
      this.client = null;
      c.release(true);
    });
    this.client = c;
    this.held = true;
    return true;
  }

  async release(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.held = false;
    if (!c) return;
    await c.query(`SELECT pg_advisory_unlock(hashtext('stocktrack.sync_agent'))`).catch(() => undefined);
    c.release();
  }
}

/** Nabız: arayüz 2 dk'dan eskiyse "ajan çalışmıyor" der. */
export async function heartbeat(db: Db, version: string): Promise<void> {
  await db.query(
    `INSERT INTO replica_state (id, agent_heartbeat_at, agent_version, updated_at) VALUES (1, now(), $1, now())
     ON CONFLICT (id) DO UPDATE SET agent_heartbeat_at = now(), agent_version = EXCLUDED.agent_version, updated_at = now()`,
    [version],
  );
}

/**
 * Bu veritabanı merkezin kendisi mi? Merkez yerel sunucu anahtarı üretir
 * (sync_replicas dolu) ve kendi kimliğini system_settings'te tutar; yerel
 * sunucuda ikisi de olmaz. Yanlış adresle merkez verisini boşaltmayı önler.
 */
export async function looksLikeCentralDb(db: Db | Client, serverId?: string): Promise<boolean> {
  const exists = async (sql: string, params: unknown[] = []): Promise<boolean> => {
    try {
      return (await db.query<{ n: boolean }>(`SELECT EXISTS (${sql}) AS n`, params)).rows[0]!.n;
    } catch (err) {
      if ((err as { code?: string }).code === '42P01' || (err as { code?: string }).code === '42703') return false;
      throw err;
    }
  };
  if (await exists(`SELECT 1 FROM sync_replicas`)) return true;
  return !!serverId && (await exists(`SELECT 1 FROM system_settings WHERE instance_id = $1::uuid`, [serverId]));
}

/** Yazma duraklatması (docs/SYNC.md § 6): en çok `seconds` sonra kendiliğinden kalkar. */
export async function setPause(db: Db, seconds: number | null): Promise<void> {
  await db.query(
    `INSERT INTO replica_state (id, writes_paused_until, updated_at)
     VALUES (1, CASE WHEN $1::int IS NULL THEN NULL ELSE now() + make_interval(secs => $1::int) END, now())
     ON CONFLICT (id) DO UPDATE SET writes_paused_until = EXCLUDED.writes_paused_until, updated_at = now()`,
    [seconds],
  );
}

export async function countExecuting(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM replica_outbox WHERE state = 'executing'`,
  );
  return rows[0]!.n;
}
