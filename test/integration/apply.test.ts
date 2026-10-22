import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApplyError, Applier } from '../../src/apply.js';
import { loadCatalog, SyncSchema, type Catalog } from '../../src/schema.js';
import type { Row } from '../../src/upstream.js';

/**
 * Yazma motoru gerçek PostgreSQL'de (sayfa sınırı ve sıra sorunları). Merkez
 * yerine bellekteki "asıl hal" kullanılır; ne zaman ve neyin sorulduğu sayılır.
 */
const ADMIN = `postgres://stocktrack:stocktrack@127.0.0.1:${process.env.TEST_REPLICA_DB_PORT ?? 55433}`;
const DB = 'st_apply_unit';

describe('Applier (gerçek PostgreSQL)', () => {
  let pool: pg.Pool;
  let schema: SyncSchema;
  let catalog: Catalog;
  let truth: Map<string, Map<string, Row>>;
  let asked: string[];

  const P = (code: string, id = randomUUID()): Row => ({ id, code, name: `P ${code}` });
  const C = (parent: string, id = randomUUID()): Row => ({ id, parent_id: parent, note: 'n' });

  async function run(fn: (a: Applier) => Promise<void>): Promise<Applier> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const a = new Applier(c, schema, catalog, async (table, ids) => {
        asked.push(`${table}:${ids.length}`);
        const t = truth.get(table) ?? new Map();
        return { rows: ids.filter((id) => t.has(id)).map((id) => t.get(id)!), missing: ids.filter((id) => !t.has(id)) };
      });
      await fn(a);
      await c.query('COMMIT');
      return a;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  }

  async function local(table: string): Promise<Record<string, unknown>[]> {
    return (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
  }

  async function seed(table: string, rows: Row[]): Promise<void> {
    await run((a) => a.upsert(table, rows).then(() => a.settle()));
  }

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: `${ADMIN}/postgres` });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
    pool = new pg.Pool({ connectionString: `${ADMIN}/${DB}`, max: 2 });
    await pool.query(`
      CREATE TABLE parents (id uuid PRIMARY KEY, code text NOT NULL, name text);
      CREATE UNIQUE INDEX parents_code_uq ON parents (code);
      CREATE TABLE children (id uuid PRIMARY KEY, parent_id uuid NOT NULL REFERENCES parents (id) ON DELETE RESTRICT, note text);
      CREATE TABLE replica_outbox (id int); CREATE TABLE replica_state (id int); CREATE TABLE sync_changes (seq int);`);
    schema = new SyncSchema({
      schemaHash: 't',
      tables: [
        { name: 'parents', scope: 'shop', order: 0, dependsOn: [], columns: [{ name: 'id' }, { name: 'code' }, { name: 'name' }] },
        { name: 'children', scope: 'shop', order: 1, dependsOn: ['parents'], columns: [{ name: 'id' }, { name: 'parent_id' }, { name: 'note' }] },
      ],
    });
    catalog = await loadCatalog(pool as never, schema);
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE children, parents');
    truth = new Map([['parents', new Map()], ['children', new Map()]]);
    asked = [];
  });

  it('katalog tek sütunlu dış anahtarı ve benzersiz indeksi bulur', () => {
    expect([...catalog.foreignKeys.values()]).toMatchObject([{ child: 'children', childColumn: 'parent_id', parent: 'parents', parentColumn: 'id' }]);
    expect(catalog.uniques.get('parents_code_uq')).toMatchObject({ table: 'parents', columns: ['code'] });
  });

  it('bir sayfa tek komutla yazılır; aynı satır iki kez gelirse sonuncusu kalır', async () => {
    const p = P('A');
    const a = await run((ap) => ap.upsert('parents', [p, P('B'), { ...p, name: 'son' }]).then(() => ap.settle()));
    expect(a.stats).toMatchObject({ upserted: 2, repaired: 0 });
    expect((await local('parents')).find((r) => r.id === p.id)?.name).toBe('son');
    expect(asked).toEqual([]);
  });

  it('yanlış sırayla gelen parti merkeze sorulmadan çözülür', async () => {
    const p = P('A');
    const c = C(p.id);
    await run(async (a) => {
      await a.upsert('children', [c]);
      await a.upsert('parents', [p]);
      await a.settle();
    });
    expect(await local('children')).toHaveLength(1);
    expect(asked).toEqual([]);
  });

  it('sayfa sınırı: alt kaydın bugünkü hali henüz gelmemiş üst kaydı gösteriyor → üst kayıt merkezden alınır', async () => {
    const p = P('A');
    const c = C(p.id);
    truth.get('parents')!.set(p.id, p);
    const a = await run((ap) => ap.applyAll([{ op: 'upsert', table: 'children', id: c.id, row: c }]));
    expect(asked).toEqual(['parents:1']);
    expect(a.stats.repaired).toBe(1);
    expect((await local('parents')).map((r) => r.id)).toEqual([p.id]);
    expect((await local('children')).map((r) => r.parent_id)).toEqual([p.id]);
  });

  it('silinen kaydı hâlâ gösteren yerel alt kayıt merkezdeki haliyle yenilenir, sonra silinir', async () => {
    const p1 = P('A');
    const p2 = P('B');
    const c = C(p1.id);
    await seed('parents', [p1, p2]);
    await seed('children', [c]);
    truth.get('parents')!.set(p2.id, p2);
    truth.get('children')!.set(c.id, { ...c, parent_id: p2.id }); // merkezde başka üst kayda taşındı
    await run((a) => a.applyAll([{ op: 'delete', table: 'parents', id: p1.id }]));
    expect(asked).toEqual(['children:1']);
    expect((await local('parents')).map((r) => r.id)).toEqual([p2.id]);
    expect((await local('children'))[0]!.parent_id).toBe(p2.id);
  });

  it('benzersiz değer çakışması: değeri tutan eski yerel kayıt merkezdeki haliyle güncellenir', async () => {
    const old = P('X');
    await seed('parents', [old]);
    const incoming = P('X');
    truth.get('parents')!.set(old.id, { ...old, code: 'Y' });
    truth.get('parents')!.set(incoming.id, incoming);
    await run((a) => a.applyAll([{ op: 'upsert', table: 'parents', id: incoming.id, row: incoming }]));
    expect(asked).toEqual(['parents:1']);
    const rows = await local('parents');
    expect(rows.find((r) => r.id === old.id)?.code).toBe('Y');
    expect(rows.find((r) => r.id === incoming.id)?.code).toBe('X');
  });

  it('çözülemiyorsa hata verir ve hiçbir şey yazılmaz (sessizce atlanmaz)', async () => {
    const good = P('G');
    const orphan = C(randomUUID()); // üst kaydı merkezde de yok
    await expect(
      run((a) =>
        a.applyAll([
          { op: 'upsert', table: 'parents', id: good.id, row: good },
          { op: 'upsert', table: 'children', id: orphan.id, row: orphan },
        ]),
      ),
    ).rejects.toThrow(ApplyError);
    expect(await local('parents')).toEqual([]);
    expect(await local('children')).toEqual([]);
  });

  it('kural dışı hata (ör. NOT NULL) onarılmaya çalışılmaz, hemen fırlatılır', async () => {
    const bad = { id: randomUUID(), name: 'kodsuz' } as Row;
    await expect(run((a) => a.upsert('parents', [bad]))).rejects.toThrow(/null value/);
    expect(asked).toEqual([]);
  });
});
