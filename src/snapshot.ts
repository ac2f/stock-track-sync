import { applierFor, type SyncContext } from './apply.js';
import { tx, upstreamTx, writeState, type Client } from './db.js';
import { ident } from './schema.js';
import { UpstreamError } from './upstream.js';

export const SNAPSHOT_PAGE = 2000;

export class NewWritesError extends Error {
  constructor() {
    super('Yükleme sırasında yeni yerel işlem geldi; yükleme bir sonraki turda baştan yapılacak.');
  }
}

export interface SnapshotSummary {
  tables: number;
  rows: number;
  ms: number;
}

/**
 * İlk yükleme / baştan yükleme (docs/SYNC.md § 7, § 8). Çağıran: yazmaları
 * duraklatmış, bekleyen işlemleri göndermiş olmalı.
 *
 * Eşitlenen tablolar tek transaction'da boşaltılır (giden kutusu, durum,
 * yerel günlük ve tekrar koruması KALIR), sonra her tablo `order` sırasıyla
 * sayfa sayfa yazılır (sayfa başına transaction; bellekte tek sayfa).
 * `snapshot_at` en sonda yazılır: yarıda kalırsa bir sonraki tur baştan yükler.
 */
export async function snapshot(
  ctx: SyncContext,
  target: { seq0: string; serverId: string },
): Promise<SnapshotSummary> {
  const started = Date.now();
  const { rows } = await ctx.db.query<{ seq: string }>(`SELECT COALESCE(MAX(seq), 0)::text AS seq FROM replica_outbox`);
  const outboxSeq = rows[0]!.seq;

  // CASCADE kullanılmaz: eşitlenmeyen bir tablo bunlara bağlıysa boşaltmak
  // yerine hata verilir (yerel veriye sessizce dokunulmasın).
  const list = ctx.schema.tables.map((t) => ident(t.name)).join(', ');
  await upstreamTx(ctx.db, async (c) => {
    await c.query(`TRUNCATE ${list}`);
    await writeState(c, { snapshot_at: null, last_seq: null, upstream_server_id: target.serverId });
  });

  let total = 0;
  for (const t of ctx.schema.tables) {
    let after: string | null = null;
    let count = 0;
    for (let page = 1; ; page++) {
      const res = await ctx.upstream.snapshot(t.name, after, SNAPSHOT_PAGE);
      if (res.table !== t.name) throw new UpstreamError('protocol', `Anlık görüntü başka tablo döndü: ${res.table}`);
      await upstreamTx(ctx.db, async (c) => {
        const applier = applierFor(c, ctx);
        await applier.upsert(t.name, res.rows);
        await applier.settle();
        await assertNoNewWrites(c, outboxSeq);
      });
      count += res.rows.length;
      if (page % 10 === 0) ctx.log.info('snapshot.progress', `${t.name}: ${count} satır yüklendi…`, { table: t.name, rows: count });
      if (res.done || !res.nextAfterId) break;
      after = res.nextAfterId;
    }
    total += count;
    if (count) ctx.log.debug('snapshot.table', `${t.name}: ${count} satır`, { table: t.name, rows: count });
  }

  await tx(ctx.db, async (c) => {
    await c.query(
      `UPDATE replica_state
          SET last_seq = $1, rebased_seq = (SELECT COALESCE(MAX(seq), 0) FROM sync_changes),
              snapshot_at = now(), upstream_server_id = $2, updated_at = now()
        WHERE id = 1`,
      [target.seq0, target.serverId],
    );
  });
  return { tables: ctx.schema.tables.length, rows: total, ms: Date.now() - started };
}

/** Yükleme sürerken yeni yerel işlem açıldıysa (duraklatma aşıldı) dur. */
async function assertNoNewWrites(c: Client, outboxSeq: string): Promise<void> {
  const { rows } = await c.query<{ n: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM replica_outbox WHERE seq > $1::bigint OR state = 'executing') AS n`,
    [outboxSeq],
  );
  if (rows[0]!.n) throw new NewWritesError();
}
