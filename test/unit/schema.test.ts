import { describe, expect, it } from 'vitest';
import { sortItems } from '../../src/apply.js';
import { chunks, groupChanges } from '../../src/rebase.js';
import { buildSql, ident, SchemaError, SyncSchema } from '../../src/schema.js';

const table = (name: string, order: number, columns = ['id', 'name']) => ({
  name,
  scope: 'shop',
  order,
  dependsOn: [],
  columns: columns.map((c) => ({ name: c })),
});

describe('ident', () => {
  it('yalnız güvenli adları çift tırnakla koyar', () => {
    expect(ident('sale_items')).toBe('"sale_items"');
    for (const bad of ['Sales', 'a"b', 'x; DROP TABLE y', '', '1abc', 'a'.repeat(64)]) {
      expect(() => ident(bad), bad).toThrow(/Geçersiz/);
    }
  });
});

describe('SyncSchema', () => {
  it('sıraya dizer, adları doğrular', () => {
    const s = new SyncSchema({ schemaHash: 'h', tables: [table('b', 2), table('a', 1)] });
    expect(s.tables.map((t) => t.name)).toEqual(['a', 'b']);
    expect(s.has('a')).toBe(true);
    expect(s.has('replica_outbox')).toBe(false);
  });
  it('korunan tabloyu, kötü adı ve id\'siz tabloyu reddeder', () => {
    expect(() => new SyncSchema({ schemaHash: 'h', tables: [table('replica_outbox', 1)] })).toThrow(SchemaError);
    expect(() => new SyncSchema({ schemaHash: 'h', tables: [table('x"', 1)] })).toThrow(SchemaError);
    expect(() => new SyncSchema({ schemaHash: 'h', tables: [table('a', 1, ['id', 'bad col'])] })).toThrow(SchemaError);
    expect(() => new SyncSchema({ schemaHash: 'h', tables: [table('a', 1, ['name'])] })).toThrow(/id sütunu yok/);
    expect(() => new SyncSchema({ schemaHash: 'h', tables: [table('a', 1), table('a', 2)] })).toThrow(/iki kez/);
  });
});

describe('buildSql', () => {
  it('sayfayı tek komutla upsert eder; id güncellenmez', () => {
    const { upsertSql, deleteSql } = buildSql('customers', ['id', 'name', 'shop_id']);
    expect(upsertSql).toBe(
      'INSERT INTO "customers" ("id", "name", "shop_id") SELECT "id", "name", "shop_id" ' +
        'FROM jsonb_populate_recordset(NULL::"customers", $1::jsonb) ' +
        'ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "shop_id" = EXCLUDED."shop_id"',
    );
    expect(deleteSql).toBe('DELETE FROM "customers" WHERE "id" = ANY($1::uuid[])');
    expect(buildSql('t', ['id']).upsertSql).toMatch(/DO NOTHING$/);
  });
});

describe('sortItems', () => {
  it('silmeler önce ve ters sırayla, upsertler artan sırayla', () => {
    const order = (t: string) => ({ parent: 1, child: 2 })[t]!;
    const items = sortItems(
      [
        { op: 'upsert', table: 'child', id: '1', row: { id: '1' } },
        { op: 'delete', table: 'parent', id: '2' },
        { op: 'upsert', table: 'parent', id: '3', row: { id: '3' } },
        { op: 'delete', table: 'child', id: '4' },
      ],
      order,
    );
    expect(items.map((i) => `${i.op}:${i.table}`)).toEqual(['delete:child', 'delete:parent', 'upsert:parent', 'upsert:child']);
  });
});

describe('rebase yardımcıları', () => {
  it('yalnız eşitlenen tabloları toplar, tekrarı atar', () => {
    const g = groupChanges(
      [
        { table_name: 'sales', ids: ['a', 'b'] },
        { table_name: 'system_settings', ids: ['x'] },
        { table_name: 'sales', ids: ['b', 'c'] },
      ],
      (t) => t !== 'system_settings',
    );
    expect([...g.entries()]).toEqual([['sales', ['a', 'b', 'c']]]);
  });
  it('1000\'lik parçalara böler', () => {
    expect(chunks(Array.from({ length: 2500 }, (_, i) => i), 1000).map((c) => c.length)).toEqual([1000, 1000, 500]);
    expect(chunks([], 1000)).toEqual([]);
  });
});
