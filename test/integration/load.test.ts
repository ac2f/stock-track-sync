import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESULTS, Stack, waitFor } from './stack.js';

/**
 * Yük (ana talimat § 10.9): ≥100.000 satırlık ilk yükleme ve saatlerce
 * çevrimdışı birikmiş ≥1.000 işlem. Süre ve ajanın en yüksek bellek kullanımı
 * (Linux VmHWM) ölçülür, .results/load.json'a yazılır (README'deki tablo).
 * Bellek sabit olmalı: 10 kat veri ≈ aynı bellek.
 */
describe('yük', () => {
  let s: Stack;
  const results: Record<string, unknown> = {};

  beforeAll(async () => {
    s = await Stack.start('load');
  });
  afterAll(async () => {
    mkdirSync(RESULTS, { recursive: true });
    writeFileSync(join(RESULTS, 'load.json'), JSON.stringify(results, null, 2));
    console.log('YÜK SONUÇLARI', JSON.stringify(results, null, 2));
    await s?.stop();
  });

  async function addCustomers(n: number): Promise<void> {
    await s.pdb.query(
      `INSERT INTO customers (id, shop_id, name, phone, address)
       SELECT gen_random_uuid(), $1, 'Toplu Müşteri ' || g, '0555' || lpad(g::text, 7, '0'), repeat('Adres satırı ', 4)
         FROM generate_series(1, $2::int) g`,
      [s.shop, n],
    );
  }

  async function timedLoad(label: string): Promise<{ rows: number; seconds: number; peakRssMb: number | null }> {
    await s.resetReplica();
    const started = Date.now();
    const agent = await s.startAgent();
    await s.waitLoaded();
    const seconds = (Date.now() - started) / 1000;
    const peakRssMb = agent.peakRssMb();
    const rows = (await s.rdb.query(`SELECT COUNT(*)::int AS n FROM customers`)).rows[0].n;
    await s.assertConverged(120_000);
    await s.stopAgent();
    const r = { rows, seconds: Math.round(seconds * 10) / 10, peakRssMb };
    results[label] = r;
    return r;
  }

  it('ilk yükleme: 10.000 ve 100.000 satır — bellek sabit', async () => {
    await addCustomers(10_000);
    const small = await timedLoad('ilkYukleme10k');
    await addCustomers(90_000);
    const big = await timedLoad('ilkYukleme100k');
    expect(big.rows).toBeGreaterThanOrEqual(100_000);
    expect(big.peakRssMb).not.toBeNull();
    expect(big.peakRssMb!).toBeLessThan(250);
    expect(big.peakRssMb! - small.peakRssMb!, '10 kat veri belleği büyütmemeli').toBeLessThan(60);
  });

  it('çevrimdışı birikmiş 1.000 işlem gönderilir, bir kez uygulanır', async () => {
    await s.startAgent();
    await s.waitLoaded();
    await s.stopAgent(); // ajan yokken (saatlerce) yerelde iş
    const lt = await s.localLogin();
    const prefix = `Çevrimdışı ${s.tag}`;
    const N = 1000;
    let next = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (next < N) {
          const i = next++;
          const r = await s.L('POST', '/customers', { token: lt, shop: s.shop, body: { name: `${prefix} ${i}` } });
          if (r.status !== 201) throw new Error(`yerel işlem başarısız: ${r.status}`);
        }
      }),
    );
    expect((await s.outbox(`state = 'pending'`)).length).toBe(N);

    const started = Date.now();
    const agent = await s.startAgent();
    await waitFor(async () => (await s.outbox(`state IN ('pending', 'pushing')`)).length === 0, {
      what: '1000 işlemin gönderimi',
      timeout: 600_000,
      interval: 1000,
    });
    const pushSeconds = (Date.now() - started) / 1000;
    await s.assertConverged(300_000);
    const totalSeconds = (Date.now() - started) / 1000;
    const peakRssMb = agent.peakRssMb();
    results.cevrimdisi1000 = {
      ops: N,
      pushSeconds: Math.round(pushSeconds * 10) / 10,
      untilConvergedSeconds: Math.round(totalSeconds * 10) / 10,
      peakRssMb,
    };
    expect((await s.outbox(`state = 'applied' AND body::text LIKE $1`, [`%${prefix}%`])).length).toBe(N);
    expect((await s.pdb.query(`SELECT COUNT(*)::int AS n FROM customers WHERE name LIKE $1`, [`${prefix}%`])).rows[0].n).toBe(N);
    expect(peakRssMb!).toBeLessThan(250);
  });
});
