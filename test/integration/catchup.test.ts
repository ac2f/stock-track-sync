import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, waitFor } from './stack.js';

/**
 * Uzun aradan sonra yakalama, gerçek sunucularla. Testler sırayla çalışır ve
 * merkezin sıra numarası büyüdükçe farklı durumları dener.
 */
describe('çok gerideyken yakalama', () => {
  let s: Stack;

  beforeAll(async () => {
    s = await Stack.start('catchup');
    await s.startAgent();
    await s.waitLoaded();
  });
  afterAll(async () => {
    await s?.stop();
  });

  async function filler(n: number, label: string): Promise<void> {
    await s.pdb.query(
      `INSERT INTO customers (id, shop_id, name) SELECT gen_random_uuid(), $1, $2 || ' ' || g FROM generate_series(1, $3::int) g`,
      [s.shop, label, n],
    );
  }

  /** Teklif açılır, araya `n` değişiklik girer, sonra teklif yeni bir müşteriyi gösterir. */
  async function quotePointingForward(n: number): Promise<{ quote: string; owner: string }> {
    const buyer = (await s.P('POST', '/customers', { token: s.owner, shop: s.shop, body: { name: `Alıcı ${Date.now()}` } })).data.id;
    const quote = (
      await s.P('POST', '/quotes', {
        token: s.owner,
        shop: s.shop,
        body: { buyerCustomerId: buyer, items: [{ lineKind: 'sale', itemName: 'Tabela', quantity: 1, unitPrice: 100, billingUnit: 'piece' }] },
      })
    ).data.id;
    await filler(n, `Dolgu ${n}`);
    const owner = (await s.P('POST', '/customers', { token: s.owner, shop: s.shop, body: { name: `Sahip ${Date.now()}` } })).data.id;
    await s.pdb.query(`UPDATE quotes SET owner_customer_id = $1 WHERE id = $2`, [owner, quote]);
    return { quote, owner };
  }

  it("merkezin sıra numarası 10'un kuvvetini aşarken (99→100→1000) birikmiş değişiklik kaybolmaz", async () => {
    // Merkez günlüğü metne göre sıraladığı için bu aralık tek sayfaya sığmazsa
    // satır atlanıyordu (bkz. src/pull.ts crossesDecade).
    expect(BigInt((await s.state()).last_seq)).toBeLessThan(100n);
    await s.stopAgent();
    const { quote, owner } = await quotePointingForward(1500);
    await s.startAgent();
    await s.assertConverged(90_000);
    expect((await s.rdb.query(`SELECT owner_customer_id FROM quotes WHERE id = $1`, [quote])).rows[0].owner_customer_id).toBe(owner);
  });

  it('ilk sayfadaki satır ancak sonraki sayfada gelecek kaydı gösteriyor → merkezden alınıp onarılır', async () => {
    const from = BigInt((await s.state()).last_seq);
    expect(from).toBeGreaterThanOrEqual(1000n); // bütün sıra numaraları 4 hane: normal sayfalar
    await s.stopAgent();
    const { quote, owner } = await quotePointingForward(1500);
    await s.startAgent();
    await s.assertConverged(90_000);
    expect((await s.rdb.query(`SELECT owner_customer_id FROM quotes WHERE id = $1`, [quote])).rows[0].owner_customer_id).toBe(owner);
    await waitFor(async () => s.agent!.lines.some((l) => /sayfa sınırındaki \d+ satır merkezden ayrıca alınıp onarıldı/.test(l)), {
      what: 'onarım günlüğü',
    });
    expect((await s.state()).last_error).toBeNull();
  });

  it("10'un kuvveti sınırında tek sayfaya sığmayacak kadar gerideyse baştan yükler", async () => {
    const from = BigInt((await s.state()).last_seq);
    await s.stopAgent();
    await filler(Number(10_500n - from), 'Sınır');
    const { quote, owner } = await quotePointingForward(10);
    const snapshotBefore = (await s.state()).snapshot_at;
    await s.startAgent();
    await waitFor(async () => new Date((await s.state()).snapshot_at) > new Date(snapshotBefore), { what: 'baştan yükleme', timeout: 90_000 });
    await s.assertConverged(90_000);
    expect(s.agent!.lines.some((l) => /10'un kuvvetini aşıyor.*baştan yükleme bitti/.test(l))).toBe(true);
    expect((await s.rdb.query(`SELECT owner_customer_id FROM quotes WHERE id = $1`, [quote])).rows[0].owner_customer_id).toBe(owner);
  });
});
