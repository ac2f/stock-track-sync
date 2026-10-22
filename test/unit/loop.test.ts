import { describe, expect, it } from 'vitest';
import { ApplyError } from '../../src/apply.js';
import { backoffMs, describeError } from '../../src/loop.js';
import { UpstreamError } from '../../src/upstream.js';

describe('backoffMs', () => {
  it('2 → 4 → 8 … üst sınıra kadar artar', () => {
    const mid = () => 0.5; // jitter yok
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffMs(n, 60, mid))).toEqual([
      2000, 4000, 8000, 16000, 32000, 60000, 60000,
    ]);
  });
  it('jitter ±%20, üst sınırı aşmaz', () => {
    expect(backoffMs(2, 60, () => 0)).toBe(3200);
    expect(backoffMs(2, 60, () => 0.999)).toBeLessThanOrEqual(4800);
    expect(backoffMs(10, 60, () => 0.999)).toBe(60000);
  });
});

describe('describeError', () => {
  it('merkez yokken açık Türkçe söyler', () => {
    expect(describeError(new UpstreamError('network', 'ECONNREFUSED'))).toMatch(/^Merkez sunucuya ulaşılamıyor \(ECONNREFUSED\)/);
    expect(describeError(new UpstreamError('auth', '401 Geçersiz anahtar', 401))).toMatch(/anahtarını kabul etmedi.*REPLICA_TOKEN/);
  });
  it('yerel veritabanı bağlantı hataları', () => {
    const e = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), { code: 'ECONNREFUSED' });
    expect(describeError(e)).toMatch(/^Yerel veritabanına ulaşılamıyor/);
    expect(describeError(Object.assign(new Error('x'), { code: '28P01' }))).toMatch(/parolası/);
  });
  it('tek satır', () => {
    expect(describeError(new ApplyError('satır\nyazılamadı'))).toBe('satır yazılamadı');
  });
});
