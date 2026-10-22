import { mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger.js';

describe('logger', () => {
  it('JSON satırı yazar; anahtarı ve parolayı asla yazmaz', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stsync-log-'));
    const token = 'str_GIZLIANAHTAR0123456789abcdef';
    const db = 'postgres://stocktrack:Parola123@127.0.0.1:5433/stocktrack';
    const log = createLogger({ dir, secrets: [token, db], console: false });
    log.error('x', `istek başarısız ${token} ${db}`, { url: db, nested: { token } });
    const [file] = readdirSync(dir);
    expect(file).toMatch(/^sync-\d{4}-\d{2}-\d{2}\.log$/);
    const text = readFileSync(join(dir, file!), 'utf8');
    expect(text).not.toContain('GIZLIANAHTAR');
    expect(text).not.toContain('Parola123');
    expect(text).toContain('str_GI…');
    const line = JSON.parse(text.trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'error', event: 'x' });
  });

  it('7 günden eski günlük dosyalarını siler', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stsync-log-'));
    const old = join(dir, 'sync-2020-01-01.log');
    const other = join(dir, 'baska.txt');
    writeFileSync(old, 'x');
    writeFileSync(other, 'x');
    const past = new Date(Date.now() - 8 * 86_400_000);
    utimesSync(old, past, past);
    utimesSync(other, past, past);
    createLogger({ dir, console: false }).info('y', 'merhaba');
    const files = readdirSync(dir);
    expect(files).not.toContain('sync-2020-01-01.log');
    expect(files).toContain('baska.txt');
  });
});
