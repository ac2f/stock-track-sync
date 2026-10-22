import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ChaosProxy } from './proxy.js';

/**
 * Entegrasyon test düzeneği: iki ayrı PostgreSQL (docker compose), GERÇEK
 * merkez ve GERÇEK yerel sunucu (stock-track/backend/dist), merkezin önünde
 * kaos vekili ve ayrı süreç olarak ajan (dist/main.js). Testler sunucuları ve
 * ajanı istediği anda öldürüp yeniden başlatabilir.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STOCK_TRACK_DIR = resolve(process.env.STOCK_TRACK_DIR ?? join(ROOT, '..', 'stock-track'));
const BACKEND = join(STOCK_TRACK_DIR, 'backend');
const COMPOSE = join(ROOT, 'test', 'integration', 'docker-compose.test.yml');
export const RESULTS = join(ROOT, 'test', 'integration', '.results');
const PDB_PORT = Number(process.env.TEST_PRIMARY_DB_PORT ?? 55432);
const RDB_PORT = Number(process.env.TEST_REPLICA_DB_PORT ?? 55433);
const PORTS = { primary: 3910, replica: 3911, proxy: 3912, status: 3913 };
export const OWNER = { email: 'owner@stocktrack.local', password: 'Owner123!' };

const dbUrl = (port: number, name: string) => `postgres://stocktrack:stocktrack@127.0.0.1:${port}/${name}`;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(
  fn: () => Promise<T | false | null | undefined>,
  opts: { what: string; timeout?: number; interval?: number },
): Promise<T> {
  const deadline = Date.now() + (opts.timeout ?? 30_000);
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`Beklenen olmadı: ${opts.what}${last ? ` (son hata: ${(last as Error).message})` : ''}`);
    }
    await sleep(opts.interval ?? 250);
  }
}

/** Alt süreç: çıktısı dosyaya ve belleğe. */
export class Proc {
  readonly lines: string[] = [];
  readonly exit: Promise<number | null>;
  exitCode: number | null | undefined = undefined;

  constructor(
    readonly child: ChildProcess,
    logFile: string,
  ) {
    const file = createWriteStream(logFile, { flags: 'a' });
    const take = (b: Buffer) => {
      file.write(b);
      for (const l of b.toString().split('\n')) if (l.trim()) this.lines.push(l);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    this.exit = new Promise((r) =>
      child.on('exit', (code, signal) => {
        this.exitCode = code ?? (signal ? -1 : null);
        file.end();
        r(code);
      }),
    );
  }

  get pid(): number {
    return this.child.pid!;
  }

  get alive(): boolean {
    return this.exitCode === undefined;
  }

  /** Belirtilen sinyali gönderir; zamanında kapanmazsa SIGKILL. */
  async stop(signal: NodeJS.Signals = 'SIGTERM', timeoutMs = 20_000): Promise<number | null> {
    if (!this.alive) return this.exitCode ?? null;
    this.child.kill(signal);
    const t = setTimeout(() => this.child.kill('SIGKILL'), timeoutMs);
    const code = await this.exit;
    clearTimeout(t);
    return code;
  }

  /** Sürecin en yüksek bellek kullanımı (Linux /proc, MB). */
  peakRssMb(): number | null {
    try {
      const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${this.pid}/status`, 'utf8'));
      return m ? Math.round(Number(m[1]) / 1024) : null;
    } catch {
      return null;
    }
  }
}

export interface Api {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export async function http(
  base: string,
  method: string,
  path: string,
  o: { token?: string; shop?: string; body?: unknown; replica?: string; headers?: Record<string, string> } = {},
): Promise<Api> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', ...o.headers };
  if (o.token) h.Authorization = `Bearer ${o.token}`;
  if (o.shop) h['X-Shop-Id'] = o.shop;
  if (o.replica) h['X-Replica-Token'] = o.replica;
  const res = await fetch(base + path, {
    method,
    headers: h,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // düz metin
  }
  const d = data as { data?: unknown } | null;
  return { status: res.status, data: d && typeof d === 'object' && 'data' in d ? d.data : data };
}

let composeChecked = false;

async function canConnect(port: number): Promise<boolean> {
  const c = new pg.Client({ connectionString: dbUrl(port, 'postgres'), connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

async function ensureDatabases(): Promise<void> {
  if (composeChecked) return;
  if (!(await canConnect(PDB_PORT)) || !(await canConnect(RDB_PORT))) {
    execFileSync('docker', ['compose', '-f', COMPOSE, 'up', '-d', '--wait'], { stdio: 'inherit' });
    await waitFor(async () => (await canConnect(PDB_PORT)) && (await canConnect(RDB_PORT)), {
      what: 'test veritabanları',
      timeout: 60_000,
    });
  }
  composeChecked = true;
}

async function recreateDb(port: number, name: string): Promise<void> {
  const c = new pg.Client({ connectionString: dbUrl(port, 'postgres') });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${name}"`);
  } finally {
    await c.end();
  }
}

export interface SchemaTable {
  name: string;
  scope: 'shop' | 'global' | 'transfer' | 'transfer_item';
  order: number;
}

export class Stack {
  readonly proxy = new ChaosProxy(`http://127.0.0.1:${PORTS.primary}`);
  readonly primaryUrl = `http://127.0.0.1:${PORTS.primary}/api/v1`;
  readonly replicaUrl = `http://127.0.0.1:${PORTS.replica}/api/v1`;
  readonly proxyUrl = `http://127.0.0.1:${PORTS.proxy}/api/v1`;
  readonly statusUrl = `http://127.0.0.1:${PORTS.status}/health`;
  readonly pdbName: string;
  readonly rdbName: string;
  readonly dir: string;
  pdb!: pg.Pool;
  rdb!: pg.Pool;
  primary: Proc | null = null;
  replica: Proc | null = null;
  agent: Proc | null = null;

  owner = '';
  shop = '';
  plate = '';
  corelKey = '';
  replicaToken = '';
  replicaId = '';
  tables: SchemaTable[] = [];
  readonly tag = Date.now().toString(36).slice(-5);

  private constructor(readonly name: string) {
    this.pdbName = `st_${name}_p`;
    this.rdbName = `st_${name}_r`;
    this.dir = join(RESULTS, name);
    mkdirSync(join(this.dir, 'agent-logs'), { recursive: true });
  }

  get replicaDbUrl(): string {
    return dbUrl(RDB_PORT, this.rdbName);
  }

  get primaryDbUrl(): string {
    return dbUrl(PDB_PORT, this.pdbName);
  }

  /** Taze iki veritabanı, iki sunucu, vekil ve merkezde test dükkânı + yerel sunucu anahtarı. */
  static async start(name: string): Promise<Stack> {
    if (!existsSync(join(BACKEND, 'dist', 'main.js'))) {
      throw new Error(
        `stock-track sunucusu derlenmemiş: ${BACKEND}/dist/main.js yok. Önce: cd ${BACKEND} && npm ci && npm run build (ya da STOCK_TRACK_DIR verin)`,
      );
    }
    if (!existsSync(join(ROOT, 'dist', 'main.js'))) throw new Error('Ajan derlenmemiş: npm run build');
    await ensureDatabases();
    const s = new Stack(name);
    await Promise.all([recreateDb(PDB_PORT, s.pdbName), recreateDb(RDB_PORT, s.rdbName)]);
    s.pdb = new pg.Pool({ connectionString: s.primaryDbUrl, max: 4 });
    s.rdb = new pg.Pool({ connectionString: s.replicaDbUrl, max: 4 });
    await Promise.all([s.startPrimary(), s.startReplica()]);
    await s.proxy.listen(PORTS.proxy);
    await s.setupShop();
    return s;
  }

  private backendEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'production',
      DB_HOST: '127.0.0.1',
      DB_USERNAME: 'stocktrack',
      DB_PASSWORD: 'stocktrack',
      DB_SYNCHRONIZE: 'true',
      SCHEDULER_ENABLED: 'false',
      APP_GLOBAL_PREFIX: 'api',
      ...extra,
    };
  }

  private async startServer(kind: 'primary' | 'replica'): Promise<Proc> {
    const env =
      kind === 'primary'
        ? this.backendEnv({
            DB_PORT: String(PDB_PORT),
            DB_NAME: this.pdbName,
            APP_PORT: String(PORTS.primary),
            SYNC_ROLE: 'primary',
            JWT_ACCESS_SECRET: 'test-primary-access-secret',
            JWT_REFRESH_SECRET: 'test-primary-refresh-secret',
            SEED_ON_BOOT: 'true',
            SYNC_GAP_WAIT_SECONDS: '5',
          })
        : this.backendEnv({
            DB_PORT: String(RDB_PORT),
            DB_NAME: this.rdbName,
            APP_PORT: String(PORTS.replica),
            SYNC_ROLE: 'replica',
            JWT_ACCESS_SECRET: 'test-replica-access-secret',
            JWT_REFRESH_SECRET: 'test-replica-refresh-secret',
            SEED_ON_BOOT: 'false',
          });
    const child = spawn(process.execPath, ['dist/main.js'], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const proc = new Proc(child, join(this.dir, `${kind}.log`));
    const url = kind === 'primary' ? this.primaryUrl : this.replicaUrl;
    await waitFor(
      async () => {
        if (!proc.alive) throw new Error(`${kind} sunucusu kapandı: ${proc.lines.slice(-5).join(' | ')}`);
        return (await http(url, 'GET', '/system/info')).status === 200;
      },
      { what: `${kind} sunucusu`, timeout: 120_000, interval: 500 },
    );
    return proc;
  }

  async startPrimary(): Promise<void> {
    this.primary = await this.startServer('primary');
  }

  async startReplica(): Promise<void> {
    this.replica = await this.startServer('replica');
  }

  async stopPrimary(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    await this.primary?.stop(signal);
    this.primary = null;
  }

  async stopReplica(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    await this.replica?.stop(signal);
    this.replica = null;
  }

  /** Yerel sunucuyu boş veritabanıyla yeniden kurar (ilk yükleme denemeleri için). */
  async resetReplica(): Promise<void> {
    await this.stopAgent();
    await this.stopReplica();
    await this.rdb.end();
    await recreateDb(RDB_PORT, this.rdbName);
    this.rdb = new pg.Pool({ connectionString: this.replicaDbUrl, max: 4 });
    await this.startReplica();
  }

  P = (method: string, path: string, o: Parameters<typeof http>[3] = {}) => http(this.primaryUrl, method, path, o);
  L = (method: string, path: string, o: Parameters<typeof http>[3] = {}) => http(this.replicaUrl, method, path, o);

  private async setupShop(): Promise<void> {
    this.owner = (await this.P('POST', '/auth/login', { body: OWNER })).data.accessToken;
    const me = (await this.P('GET', '/auth/me', { token: this.owner })).data;
    const main = me.shops[0].id as string;
    const shop = await this.P('POST', '/shops', {
      token: this.owner,
      body: { name: `Test ${this.name} ${this.tag}`, copyFromShopId: main, copyCatalog: true },
    });
    this.shop = shop.data.id;
    this.corelKey = (await this.P('POST', '/settings/corel/rotate', { token: this.owner, shop: this.shop })).data.apiKey;
    const plate = await this.P('POST', '/plates/batch', {
      token: this.owner,
      shop: this.shop,
      body: {
        items: [{ categoryName: `Vida${this.tag}`, measurementType: 'piece', name: `Vida ${this.tag}`, quantityInStock: 10 }],
      },
    });
    this.plate = plate.data.plateIds[0];
    const r = await this.P('POST', '/sync/replicas', {
      token: this.owner,
      body: { name: `Test PC ${this.name}`, shopIds: [this.shop] },
    });
    this.replicaToken = r.data.token;
    this.replicaId = r.data.replica.id;
    const schema = await http(this.primaryUrl, 'GET', '/sync/schema', { replica: this.replicaToken });
    this.tables = schema.data.tables;
  }

  agentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      UPSTREAM_URL: this.proxyUrl,
      REPLICA_TOKEN: this.replicaToken,
      LOCAL_API_URL: this.replicaUrl,
      REPLICA_DB_URL: this.replicaDbUrl,
      SYNC_INTERVAL_SECONDS: '1',
      SYNC_MAX_BACKOFF_SECONDS: '3',
      STATUS_PORT: String(PORTS.status),
      LOG_DIR: join(this.dir, 'agent-logs'),
      LOG_LEVEL: 'debug',
      ...extra,
    };
  }

  /** Ajanı ayrı süreç olarak başlatır (ayar dosyası olmayan klasörde). */
  spawnAgent(extra: Record<string, string> = {}): Proc {
    const child = spawn(process.execPath, [join(ROOT, 'dist', 'main.js')], {
      cwd: this.dir,
      env: this.agentEnv(extra),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Proc(child, join(this.dir, 'agent.out.log'));
  }

  async startAgent(extra: Record<string, string> = {}): Promise<Proc> {
    if (this.agent?.alive) throw new Error('ajan zaten çalışıyor');
    this.agent = this.spawnAgent(extra);
    return this.agent;
  }

  async stopAgent(): Promise<void> {
    await this.agent?.stop('SIGTERM');
    this.agent = null;
  }

  /** kill -9: ajan hiçbir şeyi toparlayamadan ölür. */
  async killAgent(): Promise<void> {
    await this.agent?.stop('SIGKILL');
    this.agent = null;
  }

  async state(): Promise<Record<string, any>> {
    const { rows } = await this.rdb.query(
      `SELECT * FROM replica_state WHERE id = 1`,
    );
    return rows[0] ?? {};
  }

  async outbox(where = 'true', params: unknown[] = []): Promise<Record<string, any>[]> {
    const { rows } = await this.rdb.query(`SELECT * FROM replica_outbox WHERE ${where} ORDER BY seq`, params);
    return rows;
  }

  async waitLoaded(): Promise<void> {
    await waitFor(async () => (await this.state()).snapshot_at && (await this.L('GET', '/system/info')).data.ready, {
      what: 'ilk yükleme',
      timeout: 120_000,
    });
  }

  async localLogin(): Promise<string> {
    return (await this.L('POST', '/auth/login', { body: OWNER })).data.accessToken;
  }

  /**
   * Eşitleme oturdu mu: gönderilmemiş işlem yok, merkezin günlüğünün sonuna
   * kadar çekildi, yerel günlük geri alındı, duraklatma yok.
   */
  async waitSynced(timeout = 60_000): Promise<void> {
    await waitFor(
      async () => {
        const unsent = (await this.outbox(`state IN ('executing', 'pending', 'pushing')`)).length;
        const st = await this.state();
        const pmax = BigInt((await this.pdb.query(`SELECT COALESCE(MAX(seq), 0)::text AS m FROM sync_changes`)).rows[0].m);
        const rmax = BigInt((await this.rdb.query(`SELECT COALESCE(MAX(seq), 0)::text AS m FROM sync_changes`)).rows[0].m);
        return (
          unsent === 0 &&
          !!st.snapshot_at &&
          BigInt(st.last_seq ?? -1) >= pmax &&
          BigInt(st.rebased_seq ?? -1) >= rmax &&
          (!st.writes_paused_until || new Date(st.writes_paused_until).getTime() < Date.now())
        );
      },
      { what: 'eşitlemenin oturması', timeout },
    );
  }

  /** Eşitlenen her tabloda (replikanın kapsamındaki satırlar) yerel = merkez mi? Farkları döner. */
  async diff(): Promise<string[]> {
    const scope = [this.shop];
    const out: string[] = [];
    for (const t of this.tables) {
      const any = 'ANY($1::uuid[])';
      const cond =
        t.scope === 'shop'
          ? `t.shop_id = ${any}`
          : t.scope === 'transfer'
            ? `(t.from_shop_id = ${any} OR t.to_shop_id = ${any})`
            : t.scope === 'transfer_item'
              ? `EXISTS (SELECT 1 FROM shop_transfers st WHERE st.id = t.transfer_id AND (st.from_shop_id = ${any} OR st.to_shop_id = ${any}))`
              : null;
      const sql = `SELECT COUNT(*)::int AS n, md5(COALESCE(string_agg(to_jsonb(t)::text, '|' ORDER BY t.id), '')) AS h
                     FROM "${t.name}" t ${cond ? `WHERE ${cond}` : ''}`;
      const params = cond ? [scope] : [];
      const [p, r] = await Promise.all([this.pdb.query(sql, params), this.rdb.query(sql, params)]);
      if (p.rows[0].h !== r.rows[0].h) out.push(`${t.name}: merkez ${p.rows[0].n} satır, yerel ${r.rows[0].n} satır`);
    }
    return out;
  }

  /** Oturana kadar bekler ve yerel = merkez olduğunu doğrular (fark kalırsa hata). */
  async assertConverged(timeout = 60_000): Promise<void> {
    await this.waitSynced(timeout);
    const diffs = await waitFor(async () => ((await this.diff()).length === 0 ? [] : null), {
      what: 'yerel = merkez',
      timeout: 15_000,
    }).catch(async () => this.diff());
    if (diffs.length) throw new Error(`Yerel ve merkez farklı:\n  ${diffs.join('\n  ')}`);
  }

  async health(): Promise<Record<string, any>> {
    return (await fetch(this.statusUrl)).json() as Promise<Record<string, any>>;
  }

  async stop(): Promise<void> {
    await this.stopAgent().catch(() => undefined);
    await Promise.all([this.stopPrimary(), this.stopReplica()]).catch(() => undefined);
    await this.proxy.close();
    await Promise.all([this.pdb?.end(), this.rdb?.end()]).catch(() => undefined);
  }
}
