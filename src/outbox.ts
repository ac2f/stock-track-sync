import { tx, type Db } from './db.js';
import type { Logger } from './logger.js';
import { UpstreamError, type PushOp, type PushResult, type Upstream } from './upstream.js';

/** Bir partide en çok bu kadar işlem ve (yaklaşık) bu kadar bayt gönderilir. */
export const MAX_BATCH = 100;
/** Merkezin gövde sınırı (Express varsayılanı 100 KB) altında kalmak için. */
export const MAX_BATCH_BYTES = 90 * 1024;
/**
 * Tek işlem bundan büyükse merkez hiç kabul etmez (sınırı aşan istek merkezde
 * 413 yerine 500 döner, "geçici hata" sanılıp sırayı sonsuza dek tıkardı).
 */
export const MAX_OP_BYTES = 100 * 1024 - 64;

type Next = 'applied' | 'rejected' | 'pending';

/** Merkezin sonucu → giden kutusu durumu (docs/SYNC.md § 4, push tablosu). */
export function stateFor(outcome: PushResult['outcome']): Next {
  switch (outcome) {
    case 'applied':
    case 'duplicate':
      return 'applied';
    case 'rejected':
      return 'rejected';
    default:
      return 'pending'; // retry, skipped: sıra korunur, sonra yeniden
  }
}

interface OutboxRow {
  seq: string;
  id: string;
  actor: 'user' | 'corel';
  user_id: string | null;
  shop_id: string | null;
  method: string;
  path: string;
  body: unknown;
  occurred_at: Date;
  created_ids: { table: string; id: string }[] | null;
  doc_nos: Record<string, string> | null;
}

export function toOp(r: OutboxRow): PushOp {
  return {
    opId: r.id,
    actor: r.actor === 'corel' ? 'corel' : 'user',
    userId: r.user_id,
    shopId: r.shop_id,
    method: r.method,
    path: r.path,
    body: r.body ?? null,
    occurredAt: new Date(r.occurred_at).toISOString(),
    clientIds: r.created_ids ?? [],
    docNos: r.doc_nos ?? {},
  };
}

const DOC_LABELS: Record<string, string> = { quotes: 'Teklif', shop_transfers: 'Transfer belgesi' };

export interface IdMapEntry {
  table: string;
  localId: string;
  upstreamId: string;
}

/**
 * Merkezde açılan kayıtları yereldekilerle karşılaştırır. Kimlik ya da belge
 * numarası farklı çıktıysa eşleme ve kişiye açıklama döner (işlem yine
 * uygulanmıştır; Corel klasörü eski numarayla kalmış olabilir).
 */
export function compareCreated(
  local: { createdIds: { table: string; id: string }[]; docNos: Record<string, string> },
  created: PushResult['created'],
): { idMap: IdMapEntry[] | null; note: string | null } {
  if (!created) return { idMap: null, note: null };
  const idMap: IdMapEntry[] = [];
  const notes: string[] = [];

  const tables = new Set(local.createdIds.map((x) => x.table));
  let idDiffs = 0;
  for (const table of tables) {
    const mine = local.createdIds.filter((x) => x.table === table).map((x) => x.id);
    const theirs = created.inserted.filter((x) => x.table === table).map((x) => x.id);
    const missing = mine.filter((id) => !theirs.includes(id));
    const extra = theirs.filter((id) => !mine.includes(id));
    for (let i = 0; i < Math.min(missing.length, extra.length); i++) {
      idMap.push({ table, localId: missing[i]!, upstreamId: extra[i]! });
      idDiffs++;
    }
  }
  if (idDiffs) notes.push(`${idDiffs} kayıt merkezde farklı kimlikle açıldı.`);

  for (const [table, localNo] of Object.entries(local.docNos)) {
    const upstreamNo = created.docNos[table];
    if (!upstreamNo || upstreamNo === localNo) continue;
    idMap.push({ table, localId: localNo, upstreamId: upstreamNo });
    notes.push(
      `${DOC_LABELS[table] ?? table} numarası merkezde ${upstreamNo} oldu (yerelde ${localNo}); Corel klasörü eski numarayla kalmış olabilir.`,
    );
  }
  return { idMap: idMap.length ? idMap : null, note: notes.length ? notes.join(' ') : null };
}

export function opBytes(op: unknown): number {
  return Buffer.byteLength(JSON.stringify(op));
}

/** Partinin serileştirilmiş boyutuna göre ön kısmı (en az bir işlem). */
export function fitBatch<T>(items: T[], maxCount = MAX_BATCH, maxBytes = MAX_BATCH_BYTES): T[] {
  const out: T[] = [];
  let bytes = 16;
  for (const it of items.slice(0, maxCount)) {
    const size = opBytes(it) + 1;
    if (out.length && bytes + size > maxBytes) break;
    out.push(it);
    bytes += size;
  }
  return out;
}

export interface PushSummary {
  sent: number;
  applied: number;
  rejected: number;
  /** Merkez "sonra yeniden" dedi: sıra korunsun diye bu turda durduk. */
  blocked: boolean;
}

/**
 * Giden kutusunu gönderir (docs/SYNC.md § 7 adım 4): `pending` işlemler `seq`
 * sırasıyla, ≤100'lük partiler. Gönderilenler önce `pushing` olur; ağ hatasında
 * hepsi `pending`'e döner (merkez `opId` ile tekrarı önler). `retry`/`skipped`
 * gelince durulur — sonraki işlemler atlanmaz, sırayla yeniden denenir.
 */
export class Pusher {
  constructor(
    private readonly db: Db,
    private readonly upstream: Upstream,
    private readonly log: Logger,
  ) {}

  async pushAll(maxBatches = Infinity): Promise<PushSummary> {
    const total: PushSummary = { sent: 0, applied: 0, rejected: 0, blocked: false };
    for (let i = 0; i < maxBatches; i++) {
      const { rows } = await this.db.query<OutboxRow>(
        `SELECT seq::text, id, actor, user_id, shop_id, method, path, body, occurred_at, created_ids, doc_nos
           FROM replica_outbox WHERE state = 'pending' ORDER BY seq LIMIT ${MAX_BATCH}`,
      );
      if (!rows.length) break;
      const batch = fitBatch(rows.map(toOp));
      if (batch.length === 1 && opBytes(batch[0]!) > MAX_OP_BYTES) {
        await this.rejectTooLarge(rows[0]!, opBytes(batch[0]!));
        total.sent++;
        total.rejected++;
        continue;
      }
      const r = await this.send(rows.slice(0, batch.length));
      total.sent += r.sent;
      total.applied += r.applied;
      total.rejected += r.rejected;
      if (r.blocked) {
        total.blocked = true;
        break;
      }
    }
    return total;
  }

  /** Bir partiyi gönderir; 400/413'te ikiye bölerek suçlu işlemi bulur. */
  private async send(rows: OutboxRow[]): Promise<PushSummary> {
    const { rows: marked } = await this.db.query<{ id: string }>(
      `UPDATE replica_outbox
          SET state = 'pushing', attempts = attempts + 1, last_attempt_at = now(), updated_at = now()
        WHERE id = ANY($1) AND state = 'pending' RETURNING id`,
      [rows.map((r) => r.id)],
    );
    const ids = new Set(marked.map((m) => m.id));
    const batch = rows.filter((r) => ids.has(r.id));
    if (!batch.length) return { sent: 0, applied: 0, rejected: 0, blocked: false };

    let results: PushResult[];
    try {
      ({ results } = await this.upstream.push(batch.map(toOp)));
    } catch (err) {
      await this.release(batch);
      const e = err as UpstreamError;
      if (e instanceof UpstreamError && (e.kind === 'bad_request' || e.kind === 'too_large')) {
        if (batch.length > 1) {
          this.log.warn('push.split', `Merkez partiyi kabul etmedi (${e.message}); işlemler tek tek gönderiliyor.`);
          return this.sendEach(batch);
        }
        const why = e.kind === 'too_large' ? 'işlem merkeze gönderilemeyecek kadar büyük' : 'merkez işlemi geçersiz buldu';
        await this.db.query(
          `UPDATE replica_outbox SET state = 'rejected', upstream_status = $2, error = $3, updated_at = now()
            WHERE id = $1 AND state = 'pending'`,
          [batch[0]!.id, e.status ?? null, `Gönderilemedi: ${why} (${e.message}).`],
        );
        this.log.warn('push.invalid', `İşlem gönderilemedi, kişinin kararına bırakıldı: ${batch[0]!.method} ${batch[0]!.path}`, {
          opId: batch[0]!.id,
          error: e.message,
        });
        return { sent: 1, applied: 0, rejected: 1, blocked: false };
      }
      throw err;
    }

    const byId = new Map(results.map((r) => [r.opId, r]));
    const summary: PushSummary = { sent: batch.length, applied: 0, rejected: 0, blocked: false };
    await tx(this.db, async (c) => {
      for (const row of batch) {
        const res = byId.get(row.id);
        if (!res) {
          // Merkez bu işleme yanıt vermedi: gönderilmemiş say.
          await c.query(`UPDATE replica_outbox SET state = 'pending', updated_at = now() WHERE id = $1`, [row.id]);
          summary.blocked = true;
          continue;
        }
        const next = stateFor(res.outcome);
        const body = res.body === undefined ? null : JSON.stringify(res.body);
        if (next === 'applied') {
          const { idMap, note } = compareCreated(
            { createdIds: row.created_ids ?? [], docNos: row.doc_nos ?? {} },
            res.created,
          );
          await c.query(
            `UPDATE replica_outbox SET state = 'applied', upstream_status = $2, upstream_body = $3::json,
                    error = $4, id_map = $5::jsonb, updated_at = now() WHERE id = $1`,
            [row.id, res.httpStatus ?? null, body, note, idMap ? JSON.stringify(idMap) : null],
          );
          if (note) this.log.warn('push.renumbered', note, { opId: row.id });
          summary.applied++;
        } else if (next === 'rejected') {
          await c.query(
            `UPDATE replica_outbox SET state = 'rejected', upstream_status = $2, upstream_body = $3::json,
                    error = $4, updated_at = now() WHERE id = $1`,
            [row.id, res.httpStatus ?? null, body, res.error ?? 'Merkez işlemi reddetti.'],
          );
          this.log.warn('push.rejected', `Merkez reddetti: ${row.method} ${row.path} — ${res.error ?? ''}`, { opId: row.id });
          summary.rejected++;
        } else {
          await c.query(
            `UPDATE replica_outbox SET state = 'pending', upstream_status = $2, error = $3, updated_at = now() WHERE id = $1`,
            [row.id, res.httpStatus ?? null, res.outcome === 'retry' ? (res.error ?? null) : null],
          );
          summary.blocked = true;
        }
      }
    });
    await this.db.query(`UPDATE replica_state SET last_push_at = now(), updated_at = now() WHERE id = 1`);
    return summary;
  }

  private async sendEach(batch: OutboxRow[]): Promise<PushSummary> {
    const total: PushSummary = { sent: 0, applied: 0, rejected: 0, blocked: false };
    for (const row of batch) {
      const r = await this.send([row]);
      total.sent += r.sent;
      total.applied += r.applied;
      total.rejected += r.rejected;
      if (r.blocked) {
        total.blocked = true;
        break;
      }
    }
    return total;
  }

  private async rejectTooLarge(row: OutboxRow, bytes: number): Promise<void> {
    const error = `Gönderilemedi: işlem merkeze gönderilemeyecek kadar büyük (${Math.ceil(bytes / 1024)} KB, sınır 100 KB).`;
    await this.db.query(
      `UPDATE replica_outbox SET state = 'rejected', error = $2, updated_at = now() WHERE id = $1 AND state = 'pending'`,
      [row.id, error],
    );
    this.log.warn('push.too_large', `${error} ${row.method} ${row.path}`, { opId: row.id });
  }

  /** Yanıtı alınamayan parti: `pushing` → `pending` (merkez tekrarı önler). */
  private async release(batch: OutboxRow[]): Promise<void> {
    await this.db.query(
      `UPDATE replica_outbox SET state = 'pending', updated_at = now() WHERE id = ANY($1) AND state = 'pushing'`,
      [batch.map((r) => r.id)],
    );
  }
}

/** Açılış: önceki çalışmada yarıda kalan gönderimler yeniden gönderilecek. */
export async function resetPushing(db: Db): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE replica_outbox SET state = 'pending', updated_at = now() WHERE state = 'pushing'`,
  );
  return rowCount ?? 0;
}
