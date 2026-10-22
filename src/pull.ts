import { applierFor, type Item, type SyncContext } from './apply.js';
import { assertQuiet, readState, upstreamTx } from './db.js';
import { UpstreamError, type Row } from './upstream.js';

export const CHANGES_PAGE = 1000;

export interface PullOptions {
  /** Bir turda en çok bu kadar sayfa; kalanı sonraki tura (duraklatma kısa kalsın). */
  maxPages: number;
  /** Bir turda en çok bu kadar süre (ms). */
  budgetMs: number;
  sleep: (ms: number) => Promise<void>;
}

export interface PullSummary {
  pages: number;
  changes: number;
  lastSeq: string;
  /** Daha çekilecek var (sınıra takıldı). */
  more: boolean;
}

/**
 * Merkezdeki değişiklikleri yerele çeker (docs/SYNC.md § 4 changes). Her sayfa
 * ve yeni imleç aynı transaction'da yazılır: çökme olursa ya ikisi de vardır
 * ya hiçbiri. 410 RESNAPSHOT çağırana fırlatılır (baştan yükleme).
 */
export async function pull(ctx: SyncContext, opts: PullOptions): Promise<PullSummary> {
  const state = await readState(ctx.db);
  if (state.last_seq == null) throw new Error('İmleç (last_seq) yok; önce ilk yükleme yapılmalı.');
  let since = state.last_seq;
  const started = Date.now();
  const summary: PullSummary = { pages: 0, changes: 0, lastSeq: since, more: false };

  for (;;) {
    if (summary.pages >= opts.maxPages || Date.now() - started > opts.budgetMs) {
      summary.more = true;
      break;
    }
    const page = await ctx.upstream.changes(since, CHANGES_PAGE);
    summary.pages++;
    if (BigInt(page.lastSeq) < BigInt(since)) {
      throw new UpstreamError('protocol', `Merkez imleci geri verdi (${since} → ${page.lastSeq})`);
    }

    const items: Item[] = [];
    const unknown = new Set<string>();
    for (const ch of page.changes) {
      if (!ctx.schema.has(ch.table)) {
        unknown.add(ch.table);
        continue;
      }
      if (ch.op === 'delete') items.push({ op: 'delete', table: ch.table, id: ch.id });
      else if (ch.row && ch.row.id === ch.id) items.push({ op: 'upsert', table: ch.table, id: ch.id, row: ch.row as Row });
      else throw new UpstreamError('protocol', `Değişiklik satırı eksik ya da kimliği tutmuyor: ${ch.table} ${ch.id}`);
    }
    if (unknown.size) ctx.log.warn('pull.unknown_table', `Şemada olmayan tablo değişikliği atlandı: ${[...unknown].join(', ')}`);

    if (items.length || page.lastSeq !== since) {
      const from = since;
      await upstreamTx(ctx.db, async (c) => {
        if (items.length) await applierFor(c, ctx).applyAll(items);
        await assertQuiet(c);
        const { rowCount } = await c.query(
          `UPDATE replica_state SET last_seq = $1, last_pull_at = now(), updated_at = now()
            WHERE id = 1 AND last_seq = $2`,
          [page.lastSeq, from],
        );
        if (rowCount !== 1) throw new Error('İmleç beklenmedik biçimde değişmiş; tur yeniden başlayacak.');
      });
      summary.changes += items.length;
    } else {
      await ctx.db.query(`UPDATE replica_state SET last_pull_at = now(), updated_at = now() WHERE id = 1`);
    }
    const progressed = page.lastSeq !== since;
    since = page.lastSeq;
    summary.lastSeq = since;

    if (page.waiting) {
      // Merkezde açık bir transaction bekleniyor: ilerleme yoksa sonraki tura bırak.
      if (!progressed) {
        summary.more = true;
        break;
      }
      await opts.sleep(500);
      continue;
    }
    if (!page.hasMore) break;
  }
  return summary;
}
