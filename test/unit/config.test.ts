import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, isLocalHost, loadConfig, maskDbUrl, maskToken } from '../../src/config.js';

const TOKEN = 'str_abcdefghijklmnopqrstuvwxyz012345';
const base = {
  UPSTREAM_URL: 'https://stok.ornek.com/api/v1/',
  REPLICA_TOKEN: TOKEN,
  REPLICA_DB_URL: 'postgres://stocktrack:gizli@127.0.0.1:5433/stocktrack',
};
const emptyDir = () => mkdtempSync(join(tmpdir(), 'stsync-cfg-'));

describe('loadConfig', () => {
  it('varsayılanları doldurur, sondaki / işaretini atar', () => {
    const { config, warnings } = loadConfig({ ...base }, emptyDir());
    expect(config.upstreamUrl).toBe('https://stok.ornek.com/api/v1');
    expect(config.localApiUrl).toBe('http://127.0.0.1:3000/api/v1');
    expect(config.intervalSeconds).toBe(5);
    expect(config.maxBackoffSeconds).toBe(60);
    expect(config.statusPort).toBe(3100);
    expect(warnings).toEqual([]);
  });

  it('eksik ayarları Türkçe açıklamayla bildirir', () => {
    try {
      loadConfig({}, emptyDir());
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      expect(msg).toContain('UPSTREAM_URL eksik');
      expect(msg).toContain('REPLICA_TOKEN eksik');
      expect(msg).toContain('REPLICA_DB_URL eksik');
    }
  });

  it('geçersiz anahtar ve sayıları reddeder', () => {
    expect(() => loadConfig({ ...base, REPLICA_TOKEN: 'abc' }, emptyDir())).toThrow(/REPLICA_TOKEN geçersiz/);
    expect(() => loadConfig({ ...base, SYNC_INTERVAL_SECONDS: '0' }, emptyDir())).toThrow(/SYNC_INTERVAL_SECONDS geçersiz/);
    expect(() => loadConfig({ ...base, UPSTREAM_URL: 'ftp://x' }, emptyDir())).toThrow(/UPSTREAM_URL geçersiz/);
  });

  it('config.json okur; ortam değişkeni önceliklidir; boş değer verilmemiş sayılır', () => {
    const dir = emptyDir();
    writeFileSync(
      join(dir, 'config.json'),
      '\uFEFF' + JSON.stringify({ ...base, SYNC_INTERVAL_SECONDS: 9, STATUS_PORT: 4000, LOG_DIR: 'gunluk' }),
    );
    const { config, file } = loadConfig({ SYNC_INTERVAL_SECONDS: '3', STATUS_PORT: '' }, dir);
    expect(file).toBe(join(dir, 'config.json'));
    expect(config.intervalSeconds).toBe(3);
    expect(config.statusPort).toBe(4000);
    expect(config.logDir).toBe(join(dir, 'gunluk'));
    expect(config.replicaToken).toBe(TOKEN);
  });

  it('bozuk ya da bulunamayan ayar dosyası açıkça söylenir', () => {
    const dir = emptyDir();
    writeFileSync(join(dir, 'config.json'), '{bozuk');
    expect(() => loadConfig({}, dir)).toThrow(/okunamadı/);
    expect(() => loadConfig({ CONFIG_FILE: 'yok.json' }, emptyDir())).toThrow(/CONFIG_FILE bulunamadı/);
  });

  it('internetteki merkez https değilse uyarır; yerel ağda uyarmaz', () => {
    expect(loadConfig({ ...base, UPSTREAM_URL: 'http://stok.ornek.com/api/v1' }, emptyDir()).warnings[0]).toMatch(/https/);
    expect(loadConfig({ ...base, UPSTREAM_URL: 'http://192.168.1.10/api/v1' }, emptyDir()).warnings).toEqual([]);
  });
});

describe('maskeleme', () => {
  it('anahtar ve parolayı gizler', () => {
    expect(maskToken(TOKEN)).toBe('str_ab…');
    expect(maskDbUrl(base.REPLICA_DB_URL)).toBe('postgres://stocktrack:***@127.0.0.1:5433/stocktrack');
    expect(maskDbUrl('postgres://127.0.0.1/x')).toBe('postgres://127.0.0.1/x');
  });

  it('yerel ağ adreslerini tanır', () => {
    for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.2', '172.20.0.3', 'api', 'pc.local']) {
      expect(isLocalHost(h), h).toBe(true);
    }
    for (const h of ['stok.ornek.com', '8.8.8.8', '172.40.0.1']) expect(isLocalHost(h), h).toBe(false);
  });
});
