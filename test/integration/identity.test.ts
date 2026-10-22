import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sleep, Stack, waitFor } from './stack.js';

/**
 * Eşitlemeyi durduran durumlar (ana talimat § 6.1, § 7, § 10.8): sürüm farkı,
 * yanlış merkez, geçersiz anahtar; ikinci ajan, merkezin veritabanına bağlanma
 * ve eksik ayar. Her birinde yerel sunucu çalışmaya devam eder, işlemler
 * kaybolmaz, kişi `last_error`'da açık bir Türkçe açıklama görür.
 */
describe('kimlik ve güvenlik denetimleri', () => {
  let s: Stack;
  let lt = '';

  beforeAll(async () => {
    s = await Stack.start('identity');
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

  /** Engel varken yapılan yerel işlem gönderilmez; engel kalkınca gönderilir. */
  async function heldThenSynced(name: string, unblock: () => Promise<void> | void): Promise<void> {
    const c = await s.L('POST', '/customers', { token: lt, shop: s.shop, body: { name } });
    expect(c.status).toBe(201);
    await sleep(4000);
    expect((await s.outbox(`body::text LIKE $1`, [`%${name}%`]))[0]!.state).toBe('pending');
    expect((await s.pdb.query(`SELECT 1 FROM customers WHERE id = $1`, [c.data.id])).rowCount).toBe(0);
    await unblock();
    await s.assertConverged();
    expect((await s.pdb.query(`SELECT 1 FROM customers WHERE id = $1`, [c.data.id])).rowCount).toBe(1);
    expect((await s.state()).last_error).toBeNull();
  }

  it('şema özeti farklıysa eşitleme durur, last_error dolu; düzelince sürer', async () => {
    const local = (await s.L('GET', '/system/info')).data.schemaHash;
    s.proxy.rewriteHello = (d) => ({ ...d, schemaHash: 'deadbeefdeadbeef' });
    await waitFor(async () => (await s.state()).last_error?.startsWith('Sürüm farkı'), { what: 'sürüm farkı' });
    expect((await s.state()).last_error).toBe(
      `Sürüm farkı: merkez deadbeefdeadbeef, yerel ${local}. İkisini aynı sürüme getirin.`,
    );
    expect((await s.health()).ok).toBe(false);
    // Nabız sürer: arayüz "ajan çalışıyor ama eşitleyemiyor" gösterir.
    expect((await s.L('GET', '/system/sync', { token: lt })).data.agentRunning).toBe(true);
    await heldThenSynced(`Surum ${s.tag}`, () => {
      s.proxy.rewriteHello = null;
    });
  });

  it('farklı merkeze bağlanılırsa (serverId) durur', async () => {
    s.proxy.rewriteHello = (d) => ({ ...d, serverId: randomUUID() });
    await waitFor(async () => /^Farklı bir merkeze bağlanılıyor/.test((await s.state()).last_error ?? ''), { what: 'farklı merkez' });
    await heldThenSynced(`Merkez ${s.tag}`, () => {
      s.proxy.rewriteHello = null;
    });
  });

  it('anahtar kapatılırsa (401) durur, açılınca sürer', async () => {
    expect((await s.P('PATCH', `/sync/replicas/${s.replicaId}`, { token: s.owner, body: { isActive: false } })).status).toBe(200);
    await waitFor(async () => /anahtarını kabul etmedi/.test((await s.state()).last_error ?? ''), { what: 'anahtar hatası' });
    await heldThenSynced(`Anahtar ${s.tag}`, async () => {
      await s.P('PATCH', `/sync/replicas/${s.replicaId}`, { token: s.owner, body: { isActive: true } });
    });
  });

  it('saat farkı > 2 dk uyarı olarak yazılır, eşitleme sürer', async () => {
    s.proxy.rewriteHello = (d) => ({ ...d, serverTime: new Date(Date.now() + 10 * 60_000).toISOString() });
    await waitFor(async () => /^Saat farkı: bu bilgisayarın saati merkezden 10 dk geri/.test((await s.state()).last_error ?? ''), {
      what: 'saat uyarısı',
    });
    const c = await s.L('POST', '/customers', { token: lt, shop: s.shop, body: { name: `Saat ${s.tag}` } });
    await waitFor(async () => (await s.pdb.query(`SELECT 1 FROM customers WHERE id = $1`, [c.data.id])).rowCount === 1, {
      what: 'uyarıya rağmen gönderim',
    });
    s.proxy.rewriteHello = null;
    await waitFor(async () => (await s.state()).last_error === null, { what: 'uyarının kalkması' });
  });

  it('ikinci ajan kopyası açıkça söyleyip çıkar (kod 2)', async () => {
    const second = s.spawnAgent({ STATUS_PORT: '0', LOG_DIR: `${s.dir}/second-logs` });
    expect(await second.exit).toBe(2);
    expect(second.lines.join('\n')).toMatch(/başka bir eşitleme ajanı zaten çalışıyor/);
    expect(s.agent?.alive).toBe(true);
  });

  it('REPLICA_DB_URL merkezin veritabanını gösterirse hiçbir şeye dokunmadan çıkar (kod 2)', async () => {
    const before = (await s.pdb.query(`SELECT COUNT(*)::int AS n FROM customers`)).rows[0].n;
    const wrong = s.spawnAgent({ STATUS_PORT: '0', REPLICA_DB_URL: s.primaryDbUrl, LOG_DIR: `${s.dir}/wrong-logs` });
    expect(await wrong.exit).toBe(2);
    expect(wrong.lines.join('\n')).toMatch(/merkez sunucunun veritabanını gösteriyor/);
    expect((await s.pdb.query(`SELECT COUNT(*)::int AS n FROM customers`)).rows[0].n).toBe(before);
    expect((await s.pdb.query(`SELECT COUNT(*)::int AS n FROM replica_state`)).rows[0].n).toBe(0);
  });

  it('eksik ayarla Türkçe açıklama verip çıkar (kod 1), anahtarı yazmaz', async () => {
    const bad = s.spawnAgent({ STATUS_PORT: '0', UPSTREAM_URL: '', REPLICA_TOKEN: 'yanlis' });
    expect(await bad.exit).toBe(1);
    const out = bad.lines.join('\n');
    expect(out).toMatch(/UPSTREAM_URL eksik/);
    expect(out).toMatch(/REPLICA_TOKEN geçersiz/);
  });

  it('günlükte anahtar ve parola yok', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = `${s.dir}/agent-logs`;
    const text = readdirSync(dir).map((f) => readFileSync(`${dir}/${f}`, 'utf8')).join('\n') + s.agent!.lines.join('\n');
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain(s.replicaToken);
    expect(text).not.toContain(':stocktrack@');
  });
});
