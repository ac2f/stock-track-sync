import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sleep, Stack, waitFor } from './stack.js';

/**
 * Kişinin kararı (ana talimat § 10.4, § 6.5-5): reddedilen ve belirsiz işlemler
 * kişi karar vermeden gönderilmez/silinmez; "yeniden dene" sırayla gönderir,
 * "vazgeç" hiç göndermez ve yerel etkisi kalkar.
 */
describe('vazgeç / yeniden dene / belirsiz', () => {
  let s: Stack;
  let lt = '';
  let cust = '';

  beforeAll(async () => {
    s = await Stack.start('decisions');
    await s.startAgent();
    await s.waitLoaded();
    lt = await s.localLogin();
    cust = (await s.L('POST', '/customers', { token: lt, shop: s.shop, body: { name: `Karar ${s.tag}` } })).data.id;
  });
  afterAll(async () => {
    await s?.stop();
  });
  beforeEach(async () => {
    s.proxy.reset();
    await s.assertConverged();
  });

  async function offline(): Promise<void> {
    s.proxy.up = false;
    await waitFor(async () => (await s.state()).upstream_reachable === false, { what: 'merkez yok görülsün' });
  }

  async function stock(db: pg.Pool): Promise<number> {
    return (await db.query(`SELECT quantity_in_stock::int AS q FROM material_plates WHERE id = $1`, [s.plate])).rows[0].q;
  }

  it('reddedilen işlem "yeniden dene" ile koşullar düzelince uygulanır', async () => {
    await offline();
    await s.primarySale(5);
    const sale = await s.L('POST', '/sales', {
      token: lt,
      shop: s.shop,
      body: { buyerCustomerId: cust, items: [{ plateId: s.plate, quantity: 8, unitPrice: 1 }] },
      headers: { 'Idempotency-Key': `retry-${s.tag}-0001` },
    });
    expect(sale.status).toBe(201);
    s.proxy.up = true;
    await waitFor(async () => (await s.outbox(`id = $1 AND state = 'rejected'`, [`retry-${s.tag}-0001`]))[0], { what: 'red' });
    await s.assertConverged();
    expect(await stock(s.rdb), 'reddedilen satışın yerel etkisi kalktı').toBe(5);

    // Birkaç tur boyunca kendiliğinden gönderilmez.
    const attempts = (await s.outbox(`id = $1`, [`retry-${s.tag}-0001`]))[0]!.attempts;
    await sleep(4000);
    const still = (await s.outbox(`id = $1`, [`retry-${s.tag}-0001`]))[0]!;
    expect(still.state).toBe('rejected');
    expect(still.attempts).toBe(attempts);

    // Merkezde stok artar (alış); kişi yeniden dener.
    await s.primaryPurchase(15);
    const r = await s.L('POST', `/system/sync/outbox/retry-${s.tag}-0001/retry`, { token: lt });
    expect(r.data.state).toBe('pending');
    await waitFor(async () => (await s.outbox(`id = $1 AND state = 'applied'`, [`retry-${s.tag}-0001`]))[0], { what: 'uygulandı' });
    await s.assertConverged();
    expect(await stock(s.pdb)).toBe(12);
    expect(await stock(s.rdb)).toBe(12);
    const n = (await s.pdb.query(`SELECT COUNT(*)::int AS n FROM sales WHERE buyer_customer_id = $1`, [cust])).rows[0].n;
    expect(n).toBe(1);
  });

  it('yerel sunucu işlem ortasında öldürülür → "belirsiz": kendiliğinden gönderilmez; yeniden denenince uygulanır', async () => {
    const key = `uncertain-${s.tag}-0001`;
    const name = `Belirsiz ${s.tag}`;
    // Müşteri tablosunu kilitle: istek giden kutusuna "executing" yazıp beklesin.
    const lock = new pg.Client({ connectionString: s.replicaDbUrl });
    await lock.connect();
    await lock.query('BEGIN');
    await lock.query('LOCK TABLE customers IN EXCLUSIVE MODE');
    const pending = s
      .L('POST', '/customers', { token: lt, shop: s.shop, body: { name }, headers: { 'Idempotency-Key': key } })
      .catch((err: Error) => err);
    await waitFor(async () => (await s.outbox(`id = $1 AND state = 'executing'`, [key]))[0], { what: 'executing' });
    await s.stopReplica('SIGKILL');
    await lock.query('ROLLBACK');
    await lock.end();
    expect(await pending).toBeInstanceOf(Error);

    await s.startReplica();
    const [op] = await s.outbox(`id = $1`, [key]);
    expect(op!.state).toBe('uncertain');
    await sleep(5000);
    expect((await s.outbox(`id = $1`, [key]))[0]!.state, 'belirsiz işlem gönderilmedi').toBe('uncertain');
    expect((await s.pdb.query(`SELECT COUNT(*)::int AS n FROM customers WHERE name = $1`, [name])).rows[0].n).toBe(0);
    expect((await s.health()).uncertain).toBe(1);

    lt = await s.localLogin();
    const r = await s.L('POST', `/system/sync/outbox/${key}/retry`, { token: lt });
    expect(r.data.state).toBe('pending');
    await waitFor(async () => (await s.outbox(`id = $1 AND state = 'applied'`, [key]))[0], { what: 'uygulandı' });
    await s.assertConverged();
    expect((await s.pdb.query(`SELECT COUNT(*)::int AS n FROM customers WHERE name = $1`, [name])).rows[0].n).toBe(1);
    expect((await s.rdb.query(`SELECT COUNT(*)::int AS n FROM customers WHERE name = $1`, [name])).rows[0].n).toBe(1);
  });

  it('belirsiz işlemden vazgeçilince hiç gönderilmez, giden kutusunda iz kalır', async () => {
    const key = `uncertain-${s.tag}-0002`;
    const name = `Vazgecilen ${s.tag}`;
    const lock = new pg.Client({ connectionString: s.replicaDbUrl });
    await lock.connect();
    await lock.query('BEGIN');
    await lock.query('LOCK TABLE customers IN EXCLUSIVE MODE');
    const pending = s
      .L('POST', '/customers', { token: lt, shop: s.shop, body: { name }, headers: { 'Idempotency-Key': key } })
      .catch((err: Error) => err);
    await waitFor(async () => (await s.outbox(`id = $1 AND state = 'executing'`, [key]))[0], { what: 'executing' });
    await s.stopReplica('SIGKILL');
    await lock.query('ROLLBACK');
    await lock.end();
    await pending;
    await s.startReplica();
    lt = await s.localLogin();

    const d = await s.L('POST', `/system/sync/outbox/${key}/discard`, { token: lt });
    expect(d.data.state).toBe('discarded');
    await sleep(4000);
    await s.assertConverged();
    expect((await s.outbox(`id = $1`, [key]))[0]!.state).toBe('discarded');
    expect((await s.pdb.query(`SELECT COUNT(*)::int AS n FROM customers WHERE name = $1`, [name])).rows[0].n).toBe(0);
  });
});
