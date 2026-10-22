import type { Db } from './db.js';
import type { SchemaResponse } from './upstream.js';

/**
 * Eşitlemenin kendi tabloları ve yerel ayarlar: merkez şemasında görünse bile
 * asla yazılmaz/boşaltılmaz (giden kutusu ve kararlar kaybolmasın).
 */
export const PROTECTED_TABLES = new Set([
  'sync_changes',
  'sync_replicas',
  'replica_outbox',
  'replica_state',
  'idempotency_keys',
  'system_settings',
]);

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/** Tanımlayıcıyı SQL'e koyar: yalnız küçük harf/rakam/alt çizgi, çift tırnaklı. */
export function ident(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`Geçersiz tanımlayıcı: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

export interface TableInfo {
  name: string;
  order: number;
  columns: string[];
  upsertSql: string;
  deleteSql: string;
}

export class SchemaError extends Error {}

/**
 * Merkezin `/sync/schema` yanıtından eşitlenen tablolar. SQL'e giren her
 * tablo/sütun adı buradan gelir; yanıttaki adlar doğrulanır, korunan tablolar
 * reddedilir. Upsert/silme komutları tablo başına bir kez hazırlanır.
 */
export class SyncSchema {
  readonly tables: TableInfo[];
  readonly hash: string;
  private readonly byName: Map<string, TableInfo>;

  constructor(res: SchemaResponse) {
    this.hash = res.schemaHash;
    const seen = new Set<string>();
    this.tables = res.tables
      .map((t) => {
        if (!IDENT_RE.test(t.name)) throw new SchemaError(`Merkez şemasında geçersiz tablo adı: ${t.name}`);
        if (PROTECTED_TABLES.has(t.name)) throw new SchemaError(`Merkez şeması korunan tabloyu içeriyor: ${t.name}`);
        if (seen.has(t.name)) throw new SchemaError(`Merkez şemasında tablo iki kez: ${t.name}`);
        seen.add(t.name);
        const columns = t.columns.map((c) => c.name);
        for (const c of columns) if (!IDENT_RE.test(c)) throw new SchemaError(`Geçersiz sütun adı: ${t.name}.${c}`);
        if (!columns.includes('id')) throw new SchemaError(`${t.name} tablosunda id sütunu yok`);
        return { name: t.name, order: t.order, columns, ...buildSql(t.name, columns) };
      })
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    this.byName = new Map(this.tables.map((t) => [t.name, t]));
  }

  table(name: string): TableInfo | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }
}

/**
 * Bir sayfanın tamamı tek komutla yazılır: satırlar `to_jsonb` biçiminde
 * (veritabanı sütun adları) gelir, `jsonb_populate_recordset` tabloya çevirir.
 */
export function buildSql(table: string, columns: string[]): { upsertSql: string; deleteSql: string } {
  const t = ident(table);
  const cols = columns.map(ident);
  const update = columns.filter((c) => c !== 'id').map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`);
  const upsertSql =
    `INSERT INTO ${t} (${cols.join(', ')}) SELECT ${cols.join(', ')} ` +
    `FROM jsonb_populate_recordset(NULL::${t}, $1::jsonb) ` +
    `ON CONFLICT ("id") DO ${update.length ? `UPDATE SET ${update.join(', ')}` : 'NOTHING'}`;
  const deleteSql = `DELETE FROM ${t} WHERE "id" = ANY($1::uuid[])`;
  return { upsertSql, deleteSql };
}

/** Yerel veritabanındaki dış anahtar ve benzersizlik kuralları (çakışma onarımı için). */
export interface ForeignKey {
  name: string;
  child: string;
  childColumn: string;
  parent: string;
  parentColumn: string;
}
export interface UniqueIndex {
  name: string;
  table: string;
  columns: string[];
}
export interface Catalog {
  foreignKeys: Map<string, ForeignKey>;
  uniques: Map<string, UniqueIndex>;
}

/**
 * Yerel şemayı okur ve merkez şemasıyla karşılaştırır: eşitlenen her tablo ve
 * sütun yerelde olmalı (özetler aynıyken de, yanlış veritabanına bağlanmayı
 * yakalamak için). Tek sütunlu dış anahtarlar ve benzersiz indeksler döner.
 */
export async function loadCatalog(db: Db, schema: SyncSchema): Promise<Catalog> {
  const { rows: cols } = await db.query<{ table_name: string; column_name: string }>(
    `SELECT table_name::text, column_name::text FROM information_schema.columns
      WHERE table_schema = current_schema()`,
  );
  const local = new Map<string, Set<string>>();
  for (const c of cols) {
    let set = local.get(c.table_name);
    if (!set) local.set(c.table_name, (set = new Set()));
    set.add(c.column_name);
  }
  for (const t of schema.tables) {
    const have = local.get(t.name);
    if (!have) throw new SchemaError(`Yerel veritabanında ${t.name} tablosu yok`);
    const missing = t.columns.filter((c) => !have.has(c));
    if (missing.length) throw new SchemaError(`Yerel ${t.name} tablosunda sütun yok: ${missing.join(', ')}`);
  }
  for (const t of ['replica_outbox', 'replica_state', 'sync_changes']) {
    if (!local.has(t)) throw new SchemaError(`Yerel veritabanında ${t} tablosu yok (yerel sunucu sürümü eski mi?)`);
  }

  const { rows: fks } = await db.query<{
    name: string;
    child: string;
    parent: string;
    child_cols: string[];
    parent_cols: string[];
  }>(
    `SELECT con.conname::text AS name, ch.relname::text AS child, pa.relname::text AS parent,
            ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, o)
                    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o) AS child_cols,
            ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, o)
                    JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o) AS parent_cols
       FROM pg_constraint con
       JOIN pg_class ch ON ch.oid = con.conrelid
       JOIN pg_class pa ON pa.oid = con.confrelid
       JOIN pg_namespace ns ON ns.oid = ch.relnamespace
      WHERE con.contype = 'f' AND ns.nspname = current_schema()`,
  );
  const foreignKeys = new Map<string, ForeignKey>();
  for (const f of fks) {
    if (f.child_cols.length !== 1 || f.parent_cols.length !== 1) continue;
    if (!schema.has(f.child) || !schema.has(f.parent)) continue;
    foreignKeys.set(f.name, {
      name: f.name,
      child: f.child,
      childColumn: f.child_cols[0]!,
      parent: f.parent,
      parentColumn: f.parent_cols[0]!,
    });
  }

  const { rows: uq } = await db.query<{ name: string; table: string; cols: string[]; n: number }>(
    `SELECT i.relname::text AS name, t.relname::text AS table, x.indnatts::int AS n,
            ARRAY(SELECT a.attname::text FROM unnest(x.indkey) WITH ORDINALITY k(n, o)
                    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.n ORDER BY k.o) AS cols
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace ns ON ns.oid = t.relnamespace
      WHERE x.indisunique AND NOT x.indisprimary AND ns.nspname = current_schema()`,
  );
  const uniques = new Map<string, UniqueIndex>();
  for (const u of uq) {
    // İfade indeksleri (sütun sayısı tutmayanlar) onarılamaz; atlanır.
    if (!schema.has(u.table) || u.cols.length !== u.n) continue;
    uniques.set(u.name, { name: u.name, table: u.table, columns: u.cols });
  }
  return { foreignKeys, uniques };
}
