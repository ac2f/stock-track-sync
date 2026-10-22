import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Stack, waitFor } from './stack.js';

/**
 * Kaos (ana talimat § 10.6): gönderim ortasında ağ kesilir, ajan rebase ve
 * gönderim ortasında `kill -9` ile öldürülür, merkez yeniden başlar, aynı
 * parti iki kez gönderilir. Her adımdan sonra değişmezler (§ 6.5):
 * merkezde en çok bir kez, hiçbir işlem kaybolmaz, yerel = merkez.
 */
describe('kaos', () => {
  let s: Stack;
  let lt = '';

  beforeAll(async () => {
    s = await Stack.start('chaos');
    await s.startAgent();
    await s.waitLoaded();
    lt = await s.localLogin();
  });
  afterAll(async () => {
    await s?.stop();
  });
  beforeEach(async () => {
    s.proxy.reset();
    if (!s.agent?.alive) await s.startAgent();
    await s.assertConverged();
  });

  async function offline(): Promise<void> {
    s.proxy.up = false;
    await waitFor(async () => (await s.state()).upstream_reachable === false, { what: 'merkez yok görülsün' });
  }

  async function localCustomers(prefix: string, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await s.L('POST', '/customers', { token: lt, shop: s.shop, body: { name: `${prefix} ${i}` } });
      expect(r.status).toBe(201);
      ids.push(r.data.id);
    }
    return ids;
  }

  async function primaryCount(sql: string, params: unknown[]): Promise<number> {
    return (await s.pdb.query(`SELECT COUNT(*)::int AS n FROM ${sql}`, params)).rows[0].n;
  }

  it('gönderim ortasında ağ kesilir (merkez işledi, yanıt gelmedi): tekrar gönderilir, bir kez uygulanır', async () => {
    await offline();
    const prefix = `Kesinti ${s.tag}`;
    const ids = await localCustomers(prefix, 5);
    const sale = await s.L('POST', '/sales', {
      token: lt,
      shop: s.shop,
      body: { buyerCustomerId: ids[0], items: [{ plateId: s.plate, quantity: 1, unitPrice: 10 }] },
    });
    expect(sale.status).toBe(201);
    const pushesBefore = s.proxy.seen.filter((x) => x.includes('/sync/push')).length;
    s.proxy.dropPushResponses = 1;
    s.proxy.up = true;

    await s.assertConverged();
    expect(s.proxy.seen.filter((x) => x.includes('/sync/push')).length - pushesBefore).toBeGreaterThanOrEqual(2);
    const ops = await s.outbox(`body::text LIKE $1 OR path = '/v1/sales'`, [`%${prefix}%`]);
    expect(ops.every((o) => o.state === 'applied')).toBe(true);
    expect(ops.some((o) => o.attempts >= 2), 'aynı işlem yeniden gönderildi').toBe(true);
    expect(await primaryCount(`customers WHERE name LIKE $1`, [`${prefix}%`])).toBe(5);
    expect(await primaryCount(`sales WHERE buyer_customer_id = $1`, [ids[0]])).toBe(1);
  });

  it('ajan rebase ortasında kill -9: transaction geri alınır, duraklatma kendiliğinden kalkar, yeni ajan tamamlar', async () => {
    await offline();
    const prefix = `Rebase ${s.tag}`;
    await localCustomers(prefix, 3);
    const before = await s.state();

    let killed = false;
    s.proxy.delays = [{ re: /\/sync\/rows/, ms: 3000 }];
    s.proxy.onRequest = (path) => {
      if (path.includes('/sync/rows') && !killed) {
        killed = true;
        void s.killAgent();
      }
    };
    s.proxy.up = true;
    await waitFor(async () => killed && !s.agent, { what: 'ajan rebase sırasında öldürüldü', timeout: 30_000 });

    const st = await s.state();
    expect(st.rebased_seq, 'rebase transaction geri alındı').toBe(before.rebased_seq);
    const pausedUntil = new Date(st.writes_paused_until).getTime();
    expect(pausedUntil).toBeGreaterThan(Date.now() - 1000);
    expect(pausedUntil).toBeLessThanOrEqual(Date.now() + 31_000);
    expect((await s.outbox(`state = 'pending' OR state = 'pushing'`)).length, 'işlemler rebase öncesi gönderilmişti').toBe(0);

    // Ajan yokken duraklatma en çok 30 sn sonra kalkar; yerel yazma yeniden çalışır.
    await waitFor(async () => new Date((await s.state()).writes_paused_until).getTime() < Date.now(), {
      what: 'duraklatmanın kendiliğinden kalkması',
      timeout: 35_000,
    });
    const after = await s.L('POST', '/customers', { token: lt, shop: s.shop, body: { name: `${prefix} sonra` } });
    expect(after.status).toBe(201);

    s.proxy.reset();
    await s.startAgent();
    await s.assertConverged();
    expect(await primaryCount(`customers WHERE name LIKE $1`, [`${prefix}%`])).toBe(4);
  });

  it('ajan gönderim ortasında kill -9 (merkez işliyor): yeniden başlayınca "pushing" geri döner, bir kez uygulanır', async () => {
    await offline();
    const prefix = `Gonderim ${s.tag}`;
    await localCustomers(prefix, 3);

    let killed = false;
    s.proxy.delays = [{ re: /\/sync\/push/, ms: 1500 }];
    s.proxy.onRequest = (path) => {
      if (path.includes('/sync/push') && !killed) {
        killed = true;
        void s.killAgent();
      }
    };
    s.proxy.up = true;
    await waitFor(async () => killed && !s.agent, { what: 'ajan gönderim sırasında öldürüldü', timeout: 30_000 });
    await waitFor(async () => (await primaryCount(`customers WHERE name LIKE $1`, [`${prefix}%`])) === 3, {
      what: 'merkez yarım kalan partiyi işledi',
    });
    const stuck = await s.outbox(`body::text LIKE $1`, [`%${prefix}%`]);
    expect(stuck.every((o) => o.state === 'pushing')).toBe(true);

    s.proxy.reset();
    await s.startAgent();
    await s.assertConverged();
    const ops = await s.outbox(`body::text LIKE $1`, [`%${prefix}%`]);
    expect(ops.every((o) => o.state === 'applied' && o.attempts >= 2)).toBe(true);
    expect(await primaryCount(`customers WHERE name LIKE $1`, [`${prefix}%`])).toBe(3);
  });

  it('merkez çöker ve yeniden başlar: ajan bekler, sonra kendiliğinden eşitler', async () => {
    await s.stopPrimary('SIGKILL');
    const prefix = `Cokme ${s.tag}`;
    await localCustomers(prefix, 2);
    await waitFor(
      async () => {
        const st = await s.state();
        return st.upstream_reachable === false && /Merkez sunucuya ulaşılamıyor/.test(st.last_error ?? '') && st;
      },
      { what: 'merkez yok durumu' },
    );
    const h = await s.health();
    expect(h.upstream).toBe(false);
    expect(h.pending).toBe(2);
    // Nabız merkez yokken de sürer (arayüz "ajan çalışıyor" der).
    const hb1 = new Date((await s.state()).agent_heartbeat_at).getTime();
    await waitFor(async () => new Date((await s.state()).agent_heartbeat_at).getTime() > hb1, {
      what: 'nabız',
      timeout: 15_000,
    });

    await s.startPrimary();
    await s.assertConverged();
    expect(await primaryCount(`customers WHERE name LIKE $1`, [`${prefix}%`])).toBe(2);
    expect((await s.state()).last_error).toBeNull();
  });

  it('aynı parti ikinci kez gönderilirse merkez "duplicate" der, hiçbir şey iki kez uygulanmaz', async () => {
    const applied = (await s.outbox(`state = 'applied'`)).slice(-5);
    expect(applied.length).toBeGreaterThan(0);
    const ops = applied.map((r) => ({
      opId: r.id,
      actor: r.actor,
      userId: r.user_id,
      shopId: r.shop_id,
      method: r.method,
      path: r.path,
      body: r.body,
      occurredAt: new Date(r.occurred_at).toISOString(),
      clientIds: r.created_ids,
      docNos: r.doc_nos,
    }));
    const customersBefore = await primaryCount(`customers WHERE shop_id = $1`, [s.shop]);
    const salesBefore = await primaryCount(`sales WHERE shop_id = $1`, [s.shop]);
    const res = await s.P('POST', '/sync/push', { replica: s.replicaToken, body: { ops } });
    expect(res.status).toBe(200);
    expect(res.data.results.map((r: { outcome: string }) => r.outcome)).toEqual(ops.map(() => 'duplicate'));
    expect(await primaryCount(`customers WHERE shop_id = $1`, [s.shop])).toBe(customersBefore);
    expect(await primaryCount(`sales WHERE shop_id = $1`, [s.shop])).toBe(salesBefore);
    await s.assertConverged();
  });
});
