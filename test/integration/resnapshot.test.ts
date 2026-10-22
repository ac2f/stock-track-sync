import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, waitFor } from './stack.js';

/**
 * 410 RESNAPSHOT (ana talimat § 10.7): merkez imlecin gerisini silmişse
 * bekleyen işlemler ÖNCE gönderilir, sonra eşitlenen tablolar baştan yüklenir;
 * giden kutusu (kararlar dahil) korunur.
 */
describe('baştan yükleme (410)', () => {
  let s: Stack;

  beforeAll(async () => {
    s = await Stack.start('resnap');
    await s.startAgent();
    await s.waitLoaded();
  });
  afterAll(async () => {
    await s?.stop();
  });

  it('bekleyen işlemler gönderilir, sonra baştan yüklenir; giden kutusu korunur', async () => {
    const lt = await s.localLogin();
    // Önceden reddedilmiş bir işlem (kişinin kararını bekliyor) — korunmalı.
    s.proxy.up = false;
    await waitFor(async () => (await s.state()).upstream_reachable === false, { what: 'merkez yok' });
    const c = (await s.L('POST', '/customers', { token: lt, shop: s.shop, body: { name: `Red ${s.tag}` } })).data.id;
    await s.primarySale(8);
    await s.L('POST', '/sales', { token: lt, shop: s.shop, body: { buyerCustomerId: c, items: [{ plateId: s.plate, quantity: 5, unitPrice: 1 }] } });
    s.proxy.up = true;
    await waitFor(async () => (await s.outbox(`state = 'rejected'`))[0], { what: 'red' });
    await s.assertConverged();

    // Merkez yokken yerelde iş; yerelde merkezde olmayan "artık" satır (günlüğe girmeden).
    s.proxy.up = false;
    await waitFor(async () => (await s.state()).upstream_reachable === false, { what: 'merkez yok' });
    const pendingCustomer = (await s.L('POST', '/customers', { token: lt, shop: s.shop, body: { name: `Bekleyen ${s.tag}` } })).data.id;
    const junk = '0b6c5a9e-0000-4000-8000-00000000abcd';
    await s.rdb.query(`BEGIN; SET LOCAL stocktrack.sync_origin = 'upstream';
      INSERT INTO customers (id, shop_id, name) VALUES ('${junk}', '${s.shop}', 'Artık'); COMMIT;`);
    const outboxBefore = await s.outbox();
    const snapshotBefore = (await s.state()).snapshot_at;

    // Merkez günlüğü budamış gibi: yerel imleç artık geçersiz.
    await s.pdb.query(`UPDATE system_settings SET sync_pruned_seq = (SELECT MAX(seq) FROM sync_changes) + 1`);
    s.proxy.up = true;

    await waitFor(async () => {
      const st = await s.state();
      return st.snapshot_at && new Date(st.snapshot_at) > new Date(snapshotBefore) && st;
    }, { what: 'baştan yükleme', timeout: 60_000 });
    await s.assertConverged();

    expect((await s.rdb.query(`SELECT 1 FROM customers WHERE id = $1`, [junk])).rowCount, 'artık satır gitti').toBe(0);
    expect((await s.pdb.query(`SELECT 1 FROM customers WHERE id = $1`, [pendingCustomer])).rowCount, 'bekleyen işlem önce gönderildi').toBe(1);
    expect((await s.rdb.query(`SELECT 1 FROM customers WHERE id = $1`, [pendingCustomer])).rowCount).toBe(1);
    const outboxAfter = await s.outbox();
    expect(outboxAfter.map((o) => o.id)).toEqual(outboxBefore.map((o) => o.id));
    expect(outboxAfter.filter((o) => o.state === 'rejected')).toHaveLength(1);
    expect(outboxAfter.filter((o) => o.state === 'pending')).toHaveLength(0);
    expect(s.agent!.lines.some((l) => /410\)?, baştan yükleme bitti/.test(l))).toBe(true);
  });

  it('merkezin günlüğü tamamen budanmışsa (hello.seq = 0) baştan yükleme döngüye girmez', async () => {
    await s.stopAgent();
    // Yerel sunucu uzun süre kapalıyken merkezde iş yapıldı, sonra günlük tamamen budandı.
    // (Merkezin kendi budaması system_settings'i güncellediği için günlükte bir
    // satır bırakır; burada o da bırakılmadan en kötü durum kuruluyor.)
    await s.primarySale(1);
    let last = '';
    await waitFor(async () => {
      const m = (await s.pdb.query(`SELECT MAX(seq)::text AS m FROM sync_changes`)).rows[0].m as string;
      const stable = m === last;
      last = m;
      return stable;
    }, { what: 'merkez günlüğünün durulması', interval: 1500 });
    const c = await s.pdb.connect();
    let pruned = '';
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL stocktrack.sync_origin = 'upstream'`);
      const { rows } = await c.query(
        `WITH d AS (DELETE FROM sync_changes RETURNING seq)
         UPDATE system_settings SET sync_pruned_seq = (SELECT MAX(seq) FROM d) RETURNING sync_pruned_seq::text AS p`,
      );
      pruned = rows[0].p;
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const hello = (await s.P('GET', '/sync/hello', { replica: s.replicaToken })).data;
    expect(hello.seq).toBe('0');
    expect(hello.prunedSeq).toBe(pruned);

    await s.startAgent();
    await waitFor(async () => (await s.state()).last_seq === pruned && s.agent!.lines.some((l) => /baştan yükleme bitti/.test(l)), {
      what: 'baştan yükleme',
      timeout: 60_000,
    });
    await new Promise((r) => setTimeout(r, 5000));
    expect(s.agent!.lines.filter((l) => /baştan yükleme bitti/.test(l)), 'bir kez yüklendi').toHaveLength(1);
    expect((await s.state()).last_error).toBeNull();
    await s.primarySale(1);
    await s.assertConverged();
  });
});
