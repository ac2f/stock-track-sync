import { applierFor, type SyncContext } from './apply.js';
import { assertQuiet, readState, upstreamTx } from './db.js';

/** POST /sync/rows sınırı. */
export const ROWS_CHUNK = 1000;
/**
 * Yerel günlükte sıra boşluğu: açık bir yerel transaction'ın numarası
 * olabilir. Boşluktan sonraki satır bu kadar saniyeden yeniyse orada durulur
 * (merkezdeki boşluk kuralının yereldeki karşılığı).
 */
export const LOCAL_GAP_WAIT_SECONDS = 10;

export interface RebaseSummary {
  rows: number;
  upserted: number;
  deleted: number;
  repaired: number;
  rebasedSeq: string;
}

/** Tabloya göre gruplanmış yerel değişiklikler (yalnız eşitlenen tablolar). */
export function groupChanges(
  rows: { table_name: string; ids: string[] }[],
  isSynced: (table: string) => boolean,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (!isSynced(r.table_name) || !r.ids.length) continue;
    out.set(r.table_name, [...new Set([...(out.get(r.table_name) ?? []), ...r.ids])]);
  }
  return out;
}

export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Yerelde değişen satırları merkezdeki asıl hale döndürür (docs/SYNC.md § 7
 * adım 5). Yalnız gönderilmeyi bekleyen işlem yokken çağrılır: gönderilmiş
 * işlemlerin etkisi merkezdeki haliyle değişir, reddedilen/vazgeçilen ya da
 * belirsiz işlemlerin etkisi kalkar. Hepsi ve `rebased_seq` tek transaction.
 */
export async function rebase(ctx: SyncContext): Promise<RebaseSummary | null> {
  const from = (await readState(ctx.db)).rebased_seq ?? '0';
  const { rows: cut } = await ctx.db.query<{ max: string | null; gap: string | null }>(
    `WITH s AS (
       SELECT seq, changed_at, lag(seq) OVER (ORDER BY seq) AS prev FROM sync_changes WHERE seq > $1::bigint
     )
     SELECT (SELECT MAX(seq) FROM s)::text AS max,
            (SELECT MIN(seq) FROM s
              WHERE COALESCE(prev, $1::bigint) <> seq - 1
                AND changed_at > clock_timestamp() - make_interval(secs => $2))::text AS gap`,
    [from, LOCAL_GAP_WAIT_SECONDS],
  );
  const { max, gap } = cut[0]!;
  if (!max) return null;
  const upto = gap ? (BigInt(gap) - 1n).toString() : max;
  if (BigInt(upto) <= BigInt(from)) return null;

  const { rows } = await ctx.db.query<{ table_name: string; ids: string[] }>(
    `SELECT table_name::text, array_agg(DISTINCT row_id::text) AS ids
       FROM sync_changes WHERE seq > $1::bigint AND seq <= $2::bigint GROUP BY table_name`,
    [from, upto],
  );
  const byTable = groupChanges(rows, (t) => ctx.schema.has(t));
  const total = [...byTable.values()].reduce((n, ids) => n + ids.length, 0);

  const stats = await upstreamTx(ctx.db, async (c) => {
    const applier = applierFor(c, ctx);
    const missing = new Map<string, string[]>();
    // Upsert'ler bağımlılık sırasıyla, gelir gelmez (bellekte bir parça kalır);
    // merkezde olmayanlar sonda, ters sırayla silinir.
    for (const t of ctx.schema.tables) {
      for (const ids of chunks(byTable.get(t.name) ?? [], ROWS_CHUNK)) {
        const res = await ctx.upstream.rows(t.name, ids);
        await applier.upsert(t.name, res.rows);
        if (res.missing.length) missing.set(t.name, [...(missing.get(t.name) ?? []), ...res.missing]);
      }
    }
    for (const t of [...ctx.schema.tables].reverse()) await applier.delete(t.name, missing.get(t.name) ?? []);
    await applier.settle();
    await assertQuiet(c);
    await c.query(`UPDATE replica_state SET rebased_seq = $1, updated_at = now() WHERE id = 1`, [upto]);
    return applier.stats;
  });
  return { rows: total, ...stats, rebasedSeq: upto };
}
