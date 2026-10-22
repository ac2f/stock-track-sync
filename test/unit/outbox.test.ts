import { describe, expect, it } from 'vitest';
import { compareCreated, fitBatch, stateFor, toOp } from '../../src/outbox.js';

describe('stateFor (merkezin sonucu → giden kutusu durumu)', () => {
  it.each([
    ['applied', 'applied'],
    ['duplicate', 'applied'],
    ['rejected', 'rejected'],
    ['retry', 'pending'],
    ['skipped', 'pending'],
  ] as const)('%s → %s', (outcome, state) => expect(stateFor(outcome)).toBe(state));
});

describe('toOp', () => {
  it('giden kutusu satırını birebir işleme çevirir', () => {
    const at = new Date('2026-10-18T14:00:00.000Z');
    expect(
      toOp({
        seq: '7',
        id: 'op-12345678',
        actor: 'corel',
        user_id: null,
        shop_id: 's1',
        method: 'POST',
        path: '/v1/corel/jobs/x/folders?a=1',
        body: { folder: 'D:\\x' },
        occurred_at: at,
        created_ids: null,
        doc_nos: null,
      }),
    ).toEqual({
      opId: 'op-12345678',
      actor: 'corel',
      userId: null,
      shopId: 's1',
      method: 'POST',
      path: '/v1/corel/jobs/x/folders?a=1',
      body: { folder: 'D:\\x' },
      occurredAt: '2026-10-18T14:00:00.000Z',
      clientIds: [],
      docNos: {},
    });
  });
});

describe('compareCreated', () => {
  const local = {
    createdIds: [
      { table: 'quotes', id: 'q1' },
      { table: 'quote_items', id: 'i1' },
      { table: 'quote_items', id: 'i2' },
    ],
    docNos: { quotes: 'TKF-2026-0042' },
  };

  it('aynıysa not düşmez', () => {
    expect(
      compareCreated(local, {
        inserted: [...local.createdIds, { table: 'stock_levels', id: 'x' }],
        docNos: { quotes: 'TKF-2026-0042' },
      }),
    ).toEqual({ idMap: null, note: null });
    expect(compareCreated(local, undefined)).toEqual({ idMap: null, note: null });
  });

  it('farklı numara ve kimliği eşler, kişiye açıklar', () => {
    const r = compareCreated(local, {
      inserted: [
        { table: 'quotes', id: 'q1' },
        { table: 'quote_items', id: 'i1' },
        { table: 'quote_items', id: 'Z' },
      ],
      docNos: { quotes: 'TKF-2026-0043' },
    });
    expect(r.idMap).toEqual([
      { table: 'quote_items', localId: 'i2', upstreamId: 'Z' },
      { table: 'quotes', localId: 'TKF-2026-0042', upstreamId: 'TKF-2026-0043' },
    ]);
    expect(r.note).toContain('1 kayıt merkezde farklı kimlikle');
    expect(r.note).toContain('Teklif numarası merkezde TKF-2026-0043 oldu (yerelde TKF-2026-0042)');
  });
});

describe('fitBatch', () => {
  it('en çok 100 işlem', () => {
    expect(fitBatch(Array.from({ length: 250 }, (_, i) => ({ i })))).toHaveLength(100);
  });
  it('bayt sınırını aşmaz ama en az bir işlem gönderir', () => {
    const big = { body: 'x'.repeat(40_000) };
    expect(fitBatch([big, big, big])).toHaveLength(2);
    expect(fitBatch([{ body: 'x'.repeat(200_000) }, big])).toHaveLength(1);
  });
});
