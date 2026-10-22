import type { Client, Db } from './db.js';
import type { Logger } from './logger.js';
import { ident, type Catalog, type SyncSchema } from './schema.js';
import type { Row, Upstream } from './upstream.js';

/** Kimlikle merkezdeki bugünkü hal (POST /sync/rows). */
export type Fetcher = (table: string, ids: string[]) => Promise<{ rows: Row[]; missing: string[] }>;

export type Item =
  | { op: 'upsert'; table: string; id: string; row: Row }
  | { op: 'delete'; table: string; id: string };

interface PgError extends Error {
  code?: string;
  constraint?: string;
}

/** Dış anahtar ve benzersizlik ihlali: sıra/eksik satır yüzünden; onarılabilir. */
const REPAIRABLE = new Set(['23503', '23505']);
const MAX_PASSES = 50;

export class ApplyError extends Error {}

/**
 * Merkez verisini yerel tablolara yazan motor (docs/SYNC.md § Yazma kuralı).
 * Açık bir transaction'da (origin=upstream) çalışır:
 *
 *  1. Tablo başına tek komut (sayfanın hepsi birden). Kural ihlali olursa o
 *     grup satır satır denenir; yazılamayanlar ertelenir.
 *  2. `settle()`: ertelenenler, ilerleme oldukça yeniden denenir (silmeler
 *     önce, `order` azalan; upsert'ler `order` artan).
 *  3. İlerleme yoksa ilgili satırların merkezdeki hali istenir ve yazılır:
 *     eksik üst kayıt (sayfa sınırında daha yeni bir değişiklik), silinen
 *     kaydı hâlâ gösteren alt kayıt, aynı benzersiz değeri tutan eski kayıt.
 *     Sonra yeniden denenir. Yine olmazsa hata: transaction geri alınır,
 *     imleç ilerlemez, sonraki turda yeniden denenir (sessizce atlanmaz).
 */
export class Applier {
  private deferred: Item[] = [];
  private savepoint = 0;
  private readonly refetched = new Set<string>();
  readonly stats = { upserted: 0, deleted: 0, repaired: 0 };

  constructor(
    private readonly c: Client,
    private readonly schema: SyncSchema,
    private readonly catalog: Catalog,
    private readonly fetch: Fetcher,
  ) {}

  async upsert(table: string, rows: Row[]): Promise<void> {
    if (!rows.length) return;
    const t = this.tableOf(table);
    // Aynı komutta aynı satır iki kez olamaz (ON CONFLICT): sonuncusu kalır.
    const unique = [...new Map(rows.map((r) => [r.id, r])).values()];
    if ((await this.attempt(t.upsertSql, [JSON.stringify(unique)])) === true) {
      this.stats.upserted += unique.length;
      return;
    }
    for (const row of unique) {
      if ((await this.attempt(t.upsertSql, [JSON.stringify([row])])) === true) this.stats.upserted++;
      else this.deferred.push({ op: 'upsert', table, id: row.id, row });
    }
  }

  async delete(table: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const t = this.tableOf(table);
    const unique = [...new Set(ids)];
    if ((await this.attempt(t.deleteSql, [unique])) === true) {
      this.stats.deleted += unique.length;
      return;
    }
    for (const id of unique) {
      if ((await this.attempt(t.deleteSql, [[id]])) === true) this.stats.deleted++;
      else this.deferred.push({ op: 'delete', table, id });
    }
  }

  /** Karışık bir parti: silmeler `order` azalan, upsert'ler artan sırayla; sonra `settle`. */
  async applyAll(items: Item[]): Promise<void> {
    const order = (name: string) => this.tableOf(name).order;
    const dels = new Map<string, string[]>();
    const ups = new Map<string, Row[]>();
    for (const it of items) {
      if (it.op === 'delete') (dels.get(it.table) ?? dels.set(it.table, []).get(it.table)!).push(it.id);
      else (ups.get(it.table) ?? ups.set(it.table, []).get(it.table)!).push(it.row);
    }
    for (const t of [...dels.keys()].sort((a, b) => order(b) - order(a))) await this.delete(t, dels.get(t)!);
    for (const t of [...ups.keys()].sort((a, b) => order(a) - order(b))) await this.upsert(t, ups.get(t)!);
    await this.settle();
  }

  /** Ertelenenleri bitirir; bitiremezse ApplyError. */
  async settle(): Promise<void> {
    for (let pass = 0; this.deferred.length; pass++) {
      const items = sortItems(this.deferred, (n) => this.tableOf(n).order);
      this.deferred = [];
      if (pass >= MAX_PASSES) throw this.failure(items[0]!, null);
      const failed: { item: Item; err: PgError }[] = [];
      for (const item of items) {
        const r = await this.applyOne(item);
        if (r !== true) failed.push({ item, err: r });
      }
      if (!failed.length) continue;
      if (failed.length < items.length) {
        this.deferred.push(...failed.map((f) => f.item));
        continue;
      }
      // İlerleme yok: ilgili satırları merkezden yenile.
      let repaired = false;
      for (const { item, err } of failed) {
        const rel = await this.related(item, err);
        const ids = rel?.ids.filter((id) => !this.refetched.has(`${rel.table}:${id}`)) ?? [];
        if (!rel || !ids.length) continue;
        for (const id of ids) this.refetched.add(`${rel.table}:${id}`);
        const res = await this.fetch(rel.table, ids);
        await this.delete(rel.table, res.missing);
        await this.upsert(rel.table, res.rows);
        this.stats.repaired += ids.length;
        repaired = true;
      }
      this.deferred.push(...failed.map((f) => f.item));
      if (!repaired) throw this.failure(failed[0]!.item, failed[0]!.err);
    }
  }

  private failure(item: Item, err: PgError | null): ApplyError {
    return new ApplyError(
      `Merkezden gelen veri yerele yazılamadı: ${item.table} ${item.id} (${item.op})${err ? ` — ${err.message}` : ''}`,
    );
  }

  private tableOf(name: string) {
    const t = this.schema.table(name);
    if (!t) throw new ApplyError(`Eşitlenmeyen tablo: ${name}`);
    return t;
  }

  private applyOne(item: Item): Promise<true | PgError> {
    const t = this.tableOf(item.table);
    return item.op === 'upsert'
      ? this.attempt(t.upsertSql, [JSON.stringify([item.row])]).then((r) => {
          if (r === true) this.stats.upserted++;
          return r;
        })
      : this.attempt(t.deleteSql, [[item.id]]).then((r) => {
          if (r === true) this.stats.deleted++;
          return r;
        });
  }

  /** Komutu kendi kayıt noktasında çalıştırır: başarı → true, onarılabilir ihlal → hata, diğerleri fırlatılır. */
  private async attempt(sql: string, params: unknown[]): Promise<true | PgError> {
    const sp = `st_sp${++this.savepoint}`;
    await this.c.query(`SAVEPOINT ${sp}`);
    try {
      await this.c.query(sql, params);
      await this.c.query(`RELEASE SAVEPOINT ${sp}`);
      return true;
    } catch (err) {
      await this.c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      await this.c.query(`RELEASE SAVEPOINT ${sp}`);
      const e = err as PgError;
      if (e.code && REPAIRABLE.has(e.code)) return e;
      throw e;
    }
  }

  /** Yazılamayan satırın çözümü için merkezden istenecek satırlar. */
  private async related(item: Item, err: PgError): Promise<{ table: string; ids: string[] } | null> {
    if (err.code === '23503') {
      const fk = this.catalog.foreignKeys.get(err.constraint ?? '');
      if (!fk || fk.parentColumn !== 'id') return null;
      if (item.op === 'upsert' && fk.child === item.table) {
        const v = item.row[fk.childColumn];
        return typeof v === 'string' ? { table: fk.parent, ids: [v] } : null;
      }
      if (item.op === 'delete' && fk.parent === item.table) {
        const { rows } = await this.c.query<{ id: string }>(
          `SELECT "id"::text AS id FROM ${ident(fk.child)} WHERE ${ident(fk.childColumn)} = $1 LIMIT 1000`,
          [item.id],
        );
        return { table: fk.child, ids: rows.map((r) => r.id) };
      }
      return null;
    }
    if (err.code === '23505' && item.op === 'upsert') {
      const uq = this.catalog.uniques.get(err.constraint ?? '');
      if (!uq || uq.table !== item.table) return null;
      const t = ident(uq.table);
      const cond = uq.columns.map((c) => `t.${ident(c)} = r.${ident(c)}`).join(' AND ');
      const { rows } = await this.c.query<{ id: string }>(
        `SELECT t."id"::text AS id FROM ${t} t, jsonb_populate_record(NULL::${t}, $2::jsonb) r
          WHERE t."id" <> $1::uuid AND ${cond} LIMIT 1000`,
        [item.id, JSON.stringify(item.row)],
      );
      return { table: uq.table, ids: rows.map((r) => r.id) };
    }
    return null;
  }
}

/** Silmeler önce (`order` azalan), sonra upsert'ler (`order` artan). */
export function sortItems(items: Item[], order: (table: string) => number): Item[] {
  return [...items].sort((a, b) => {
    if (a.op !== b.op) return a.op === 'delete' ? -1 : 1;
    return a.op === 'delete' ? order(b.table) - order(a.table) : order(a.table) - order(b.table);
  });
}

/** Eşitleme adımlarının ortak bağlamı. */
export interface SyncContext {
  db: Db;
  upstream: Upstream;
  schema: SyncSchema;
  catalog: Catalog;
  log: Logger;
}

/** Bağlamın merkeziyle onarım yapan bir yazıcı (açık transaction'da). */
export function applierFor(c: Client, ctx: SyncContext): Applier {
  return new Applier(c, ctx.schema, ctx.catalog, (table, ids) => ctx.upstream.rows(table, ids));
}
