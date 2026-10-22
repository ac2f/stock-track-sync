import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sleep, Stack, waitFor } from './stack.js';

/**
 * stock-track/scripts/sync-contract-test.mjs senaryosu, ajan adımları
 * (bootstrap, push, rebase, pull) yerine GERÇEK ajan çalışırken. Her adımın
 * denetimi sözleşme testindekiyle aynıdır; ek olarak sonunda eşitlenen bütün
 * tablolarda yerel = merkez doğrulanır.
 *
 * Kapsam (ana talimat § 10): 1 ilk yükleme, 2 yerelde iş ve gönderim, 3 çakışma,
 * 4 vazgeç, 5 merkezden gelen değişiklik.
 */
describe('sözleşme senaryosu (ajan çalışırken)', () => {
  let s: Stack;
  let lt = '';
  let cust: { id: string };
  let quote: { id: string; quoteNo: string };
  let firstSaleOp: Record<string, any>;
  let rejectedOp: Record<string, any>;
  let baseOutbox = '0';

  beforeAll(async () => {
    s = await Stack.start('contract');
  });
  afterAll(async () => {
    await s?.stop();
  });

  it('1) ilk yükleme: boş yerel veritabanı dolar, yerelde oturum açılır', async () => {
    const info0 = (await s.L('GET', '/system/info')).data;
    expect(info0.role).toBe('replica');
    expect(info0.ready).toBe(false);
    const base = (await s.rdb.query(`SELECT COALESCE(MAX(seq), 0)::text AS c FROM sync_changes`)).rows[0].c;

    await s.startAgent();
    await s.waitLoaded();
    const hello = (await s.P('GET', '/sync/hello', { replica: s.replicaToken })).data;
    expect(hello.schemaHash).toBe(info0.schemaHash);
    expect((await s.L('GET', '/system/info')).data.ready).toBe(true);
    const plates = await s.rdb.query(`SELECT COUNT(*)::int AS n FROM material_plates WHERE id = $1`, [s.plate]);
    expect(plates.rows[0].n).toBe(1);
    const local = await s.rdb.query(`SELECT COUNT(*)::int AS n FROM sync_changes WHERE seq > $1`, [base]);
    expect(local.rows[0].n, 'merkezden yazılanlar yerel değişiklik sayılmadı').toBe(0);
    const st = await s.state();
    expect(st.upstream_server_id).toBe(hello.serverId);
    expect(st.agent_version).toMatch(/^\d+\.\d+\.\d+/);

    lt = await s.localLogin();
    expect(lt, 'yerelde oturum açıldı (kullanıcılar ve parola özetleri yerelde)').toBeTruthy();
    await s.assertConverged();
  });

  it('2) yerelde iş (merkez yokken): giden kutusuna doğru yazılır', async () => {
    baseOutbox = (await s.rdb.query(`SELECT COALESCE(MAX(seq), 0)::text AS m FROM replica_outbox`)).rows[0].m;
    s.proxy.up = false; // merkez yok: işlemler bekler, giden kutusu incelenebilir
    await waitFor(async () => (await s.state()).upstream_reachable === false, { what: 'merkez yok görülsün' });

    cust = (await s.L('POST', '/customers', { token: lt, shop: s.shop, body: { name: `Yerel Müşteri ${s.tag}` } })).data;
    const sale = await s.L('POST', '/sales', {
      token: lt,
      shop: s.shop,
      body: { buyerCustomerId: cust.id, items: [{ plateId: s.plate, quantity: 3, unitPrice: 20 }] },
    });
    expect(sale.status).toBe(201);
    quote = (
      await s.L('POST', '/quotes', {
        token: lt,
        shop: s.shop,
        body: {
          buyerCustomerId: cust.id,
          items: [{ lineKind: 'sale', itemName: 'Tabela', quantity: 1, unitPrice: 100, billingUnit: 'piece' }],
        },
      })
    ).data;
    expect(quote.quoteNo).toMatch(/^TKF-/);

    const ob = await s.outbox('seq > $1', [baseOutbox]);
    expect(ob.map((o) => `${o.method} ${o.path}:${o.state}`)).toEqual([
      'POST /v1/customers:pending',
      'POST /v1/sales:pending',
      'POST /v1/quotes:pending',
    ]);
    expect(ob[1]!.created_ids.some((x: any) => x.table === 'sales')).toBe(true);
    expect(ob[1]!.created_ids.some((x: any) => x.table === 'customer_ledger_entries')).toBe(true);
    expect(ob[2]!.doc_nos.quotes).toBe(quote.quoteNo);
    firstSaleOp = ob[1]!;

    expect((await s.L('POST', '/users', { token: lt, body: { fullName: 'x', email: `x${s.tag}@x.x`, password: 'Xxxxxxx1!' } })).status).toBe(409);
    expect((await s.L('POST', '/settings/corel/rotate', { token: lt, shop: s.shop })).status).toBe(409);

    const ping = await fetch(`${s.replicaUrl}/corel/ping`, { headers: { 'X-Api-Key': s.corelKey } });
    expect(ping.status, 'Corel anahtarı yerelde geçerli').toBe(200);
    const corel = { 'X-Api-Key': s.corelKey, 'Content-Type': 'application/json' };
    const hb = await fetch(`${s.replicaUrl}/corel/runner/heartbeat`, {
      method: 'POST',
      headers: corel,
      body: JSON.stringify({ host: `PC-${s.tag}`, version: 't', pollSeconds: 30 }),
    });
    const fo = await fetch(`${s.replicaUrl}/corel/jobs/${quote.id}/folders`, {
      method: 'POST',
      headers: corel,
      body: JSON.stringify({ host: `PC-${s.tag}`, folder: 'D:\\Isler\\x' }),
    });
    const ob2 = await s.outbox('seq > $1', [baseOutbox]);
    expect(hb.status).toBe(200);
    expect(ob2.some((o) => o.path.includes('heartbeat')), 'runner nabzı giden kutusuna girmez').toBe(false);
    expect(fo.status).toBe(200);
    expect(ob2.some((o) => o.actor === 'corel' && o.path.includes('/folders')), 'klasör bildirimi girer').toBe(true);

    const st = (await s.L('GET', '/system/sync', { token: lt })).data;
    expect(st.role).toBe('replica');
    expect(st.outbox.pending).toBeGreaterThanOrEqual(4);
    expect(st.agentRunning).toBe(true);
    expect(st.upstreamReachable).toBe(false);
    expect(st.lastError).toMatch(/Merkez sunucuya ulaşılamıyor/);
  });

  it('3) çakışma hazırlığı: merkezde başka satış, yerelde eski stokla satış', async () => {
    const pc = (await s.P('POST', '/customers', { token: s.owner, shop: s.shop, body: { name: `Merkez Müşteri ${s.tag}` } })).data;
    const ps = await s.P('POST', '/sales', {
      token: s.owner,
      shop: s.shop,
      body: { buyerCustomerId: pc.id, items: [{ plateId: s.plate, quantity: 5, unitPrice: 20 }] },
    });
    expect(ps.status).toBe(201);
    // Yerelde stok 7 görünüyor; merkezde 5 kaldı. Yerelde 6 satılırsa merkezde reddedilir.
    const late = await s.L('POST', '/sales', {
      token: lt,
      shop: s.shop,
      body: { buyerCustomerId: cust.id, items: [{ plateId: s.plate, quantity: 6, unitPrice: 20 }] },
    });
    expect(late.status).toBe(201);
  });

  it('4) bağlantı gelince: gönderme, red ve geri alma', async () => {
    s.proxy.up = true;
    await waitFor(
      async () => {
        const ob = await s.outbox(`seq > $1`, [baseOutbox]);
        return ob.every((o) => o.state === 'applied' || o.state === 'rejected') && ob;
      },
      { what: 'gönderim', timeout: 60_000 },
    );
    const ob = await s.outbox('seq > $1', [baseOutbox]);
    expect(ob.filter((o) => o.state === 'applied')).toHaveLength(4);
    const rej = ob.filter((o) => o.state === 'rejected');
    expect(rej).toHaveLength(1);
    rejectedOp = rej[0]!;
    expect(rejectedOp.error).toMatch(/stok/i);
    expect(rejectedOp.upstream_status).toBeGreaterThanOrEqual(400);

    expect((await s.P('GET', `/customers/${cust.id}`, { token: s.owner, shop: s.shop })).status, 'aynı kimlik').toBe(200);
    const pq = (await s.P('GET', `/quotes/${quote.id}`, { token: s.owner, shop: s.shop })).data;
    expect(pq.quoteNo, 'teklif numarası korundu').toBe(quote.quoteNo);
    expect(pq.foldersPath, 'runner bildirimi merkezde').toBe('D:\\Isler\\x');
    const saleId = firstSaleOp.created_ids.find((x: any) => x.table === 'sales').id;
    const { rows: ps } = await s.pdb.query(`SELECT sale_date FROM sales WHERE id = $1`, [saleId]);
    expect(ps).toHaveLength(1);
    expect(new Date(ps[0].sale_date).toISOString(), 'satış tarihi = yerel işlem zamanı').toBe(
      new Date(firstSaleOp.occurred_at).toISOString(),
    );

    await s.assertConverged();
    const { rows: [lp] } = await s.rdb.query(`SELECT quantity_in_stock::int AS q FROM material_plates WHERE id = $1`, [s.plate]);
    const pp = (await s.P('GET', `/plates?search=Vida ${s.tag}`, { token: s.owner, shop: s.shop })).data.items[0];
    expect(lp.q).toBe(Number(pp.quantityInStock));
    expect(lp.q).toBe(2);
    const { rows: [lc] } = await s.rdb.query(`SELECT current_balance::numeric AS b FROM customers WHERE id = $1`, [cust.id]);
    const pcb = (await s.P('GET', `/customers/${cust.id}`, { token: s.owner, shop: s.shop })).data.currentBalance;
    expect(Number(lc.b)).toBe(Number(pcb));
    const { rows: [{ n: dup }] } = await s.rdb.query(`SELECT COUNT(*)::int AS n FROM sales WHERE buyer_customer_id = $1`, [cust.id]);
    expect(dup, 'reddedilen satış geri alındı, mükerrer yok').toBe(1);
    const { rows: [{ n: pdup }] } = await s.pdb.query(`SELECT COUNT(*)::int AS n FROM sales WHERE buyer_customer_id = $1`, [cust.id]);
    expect(pdup, 'merkezde bir kez uygulandı').toBe(1);
  });

  it('5) kişinin kararı: reddedilen listede, vazgeçilince düşer ve hiç gönderilmez', async () => {
    const open = (await s.L('GET', '/system/sync/outbox?limit=100', { token: lt })).data;
    const mine = open.items.find((o: any) => o.id === rejectedOp.id);
    expect(mine?.state).toBe('rejected');
    expect(mine?.error).toMatch(/stok/i);
    const before = (await s.L('GET', '/system/sync', { token: lt })).data.outbox.rejected;
    const d = await s.L('POST', `/system/sync/outbox/${rejectedOp.id}/discard`, { token: lt });
    expect(d.status).toBe(200);
    expect(d.data.state).toBe('discarded');
    expect((await s.L('GET', '/system/sync', { token: lt })).data.outbox.rejected).toBe(before - 1);
    await sleep(3000);
    const [row] = await s.outbox('id = $1', [rejectedOp.id]);
    expect(row!.state, 'vazgeçilen gönderilmez').toBe('discarded');
    await s.assertConverged();
  });

  it('6) merkezde yapılan değişiklik yerele iner, yerel arayüz görür', async () => {
    const remote = (await s.P('POST', '/customers', { token: s.owner, shop: s.shop, body: { name: `Uzak ${s.tag}` } })).data;
    await waitFor(
      async () => (await s.rdb.query(`SELECT 1 FROM customers WHERE id = $1`, [remote.id])).rowCount === 1,
      { what: 'merkezdeki müşteri yerelde' },
    );
    const seen = (await s.L('GET', `/customers/${remote.id}`, { token: lt, shop: s.shop })).data;
    expect(seen?.name).toBe(`Uzak ${s.tag}`);
    await s.assertConverged();
  });

  it('durum ucu ve replica_state', async () => {
    const h = await s.health();
    expect(h).toMatchObject({ ok: true, upstream: true, pending: 0, rejected: 0, uncertain: 0, lastError: null });
    const st = await s.state();
    expect(st.upstream_reachable).toBe(true);
    expect(st.last_error).toBeNull();
    expect(new Date(st.agent_heartbeat_at).getTime()).toBeGreaterThan(Date.now() - 20_000);
    expect(st.last_push_at).toBeTruthy();
    expect(st.last_pull_at).toBeTruthy();
    expect(st.upstream_url).toBe(s.proxyUrl);
  });
});
