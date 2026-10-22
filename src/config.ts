import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

/** Ajanın sürümü (package.json); replica_state.agent_version'a yazılır. */
export const AGENT_VERSION: string = (() => {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

export interface Config {
  upstreamUrl: string;
  replicaToken: string;
  localApiUrl: string;
  replicaDbUrl: string;
  intervalSeconds: number;
  maxBackoffSeconds: number;
  statusPort: number;
  logDir: string;
}

const KEYS = [
  'UPSTREAM_URL',
  'REPLICA_TOKEN',
  'LOCAL_API_URL',
  'REPLICA_DB_URL',
  'SYNC_INTERVAL_SECONDS',
  'SYNC_MAX_BACKOFF_SECONDS',
  'STATUS_PORT',
  'LOG_DIR',
] as const;

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//i.test(u));

const schema = z.object({
  UPSTREAM_URL: httpUrl,
  REPLICA_TOKEN: z.string().trim().regex(/^str_[A-Za-z0-9_-]{16,}$/),
  LOCAL_API_URL: httpUrl.default('http://127.0.0.1:3000/api/v1'),
  REPLICA_DB_URL: z.string().trim().regex(/^postgres(ql)?:\/\/\S+$/),
  SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(3600).default(5),
  SYNC_MAX_BACKOFF_SECONDS: z.coerce.number().int().min(2).max(3600).default(60),
  STATUS_PORT: z.coerce.number().int().min(0).max(65535).default(3100),
  LOG_DIR: z.string().trim().min(1).default('./logs'),
});

/** Kişinin anlayacağı açıklama: hangi ayar, ne olmalı. */
const HINTS: Record<(typeof KEYS)[number], string> = {
  UPSTREAM_URL: 'merkez sunucunun API adresi (örnek: https://stok.ornek.com/api/v1)',
  REPLICA_TOKEN:
    "merkezde Ayarlar › Yerel sunucular'dan üretilen anahtar (str_ ile başlar)",
  LOCAL_API_URL: 'yerel sunucunun API adresi (örnek: http://127.0.0.1:3000/api/v1)',
  REPLICA_DB_URL:
    'yerel veritabanı adresi (örnek: postgres://stocktrack:parola@127.0.0.1:5433/stocktrack)',
  SYNC_INTERVAL_SECONDS: '1 ile 3600 arasında saniye',
  SYNC_MAX_BACKOFF_SECONDS: '2 ile 3600 arasında saniye',
  STATUS_PORT: '0 (kapalı) ile 65535 arasında bir port',
  LOG_DIR: 'günlük klasörü',
};

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Ayarlar eksik ya da hatalı:\n  - ${problems.join('\n  - ')}`);
  }
}

/**
 * Ayarları okur: ortam değişkenleri + isteğe bağlı config.json (CONFIG_FILE
 * ya da çalışma klasöründeki config.json). Ortam değişkeni önceliklidir.
 * Boş değerler verilmemiş sayılır (kurulum betikleri boş alan bırakabilir).
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): { config: Config; warnings: string[]; file: string | null } {
  const file = env.CONFIG_FILE ? resolve(cwd, env.CONFIG_FILE) : resolve(cwd, 'config.json');
  let fromFile: Record<string, unknown> = {};
  let usedFile: string | null = null;
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('nesne değil');
      fromFile = parsed as Record<string, unknown>;
      usedFile = file;
    } catch (err) {
      throw new ConfigError([`${file} okunamadı: ${(err as Error).message}`]);
    }
  } else if (env.CONFIG_FILE) {
    throw new ConfigError([`CONFIG_FILE bulunamadı: ${file}`]);
  }

  const given = (v: unknown): v is string | number => v !== undefined && v !== null && String(v).trim() !== '';
  const raw: Record<string, unknown> = {};
  for (const key of KEYS) {
    const value = given(env[key]) ? env[key] : fromFile[key];
    if (given(value)) raw[key] = String(value);
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const problems = [...new Set(result.error.issues.map((i) => String(i.path[0])))].map((key) => {
      const hint = HINTS[key as (typeof KEYS)[number]] ?? '';
      return `${key} ${raw[key] === undefined ? 'eksik' : 'geçersiz'}: ${hint}`;
    });
    throw new ConfigError(problems);
  }
  const v = result.data;
  const config: Config = {
    upstreamUrl: v.UPSTREAM_URL.replace(/\/+$/, ''),
    replicaToken: v.REPLICA_TOKEN,
    localApiUrl: v.LOCAL_API_URL.replace(/\/+$/, ''),
    replicaDbUrl: v.REPLICA_DB_URL,
    intervalSeconds: v.SYNC_INTERVAL_SECONDS,
    maxBackoffSeconds: Math.max(v.SYNC_MAX_BACKOFF_SECONDS, 2),
    statusPort: v.STATUS_PORT,
    logDir: isAbsolute(v.LOG_DIR) ? v.LOG_DIR : resolve(cwd, v.LOG_DIR),
  };

  const warnings: string[] = [];
  const upstream = new URL(config.upstreamUrl);
  if (upstream.protocol !== 'https:' && !isLocalHost(upstream.hostname)) {
    warnings.push(
      `Merkez adresi https:// değil (${upstream.origin}); anahtar ve veriler internette şifresiz gider.`,
    );
  }
  return { config, warnings, file: usedFile };
}

/** Yerel ağ ya da bu bilgisayar mı (https zorunlu değil)? */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || !h.includes('.')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/** Anahtarı günlükte gösterilebilir yapar: `str_ab…`. */
export function maskToken(token: string): string {
  return token.length > 6 ? `${token.slice(0, 6)}…` : '…';
}

/** Veritabanı adresindeki parolayı gizler. */
export function maskDbUrl(url: string): string {
  return url.replace(/^(postgres(?:ql)?:\/\/[^:/@]*):[^@]*@/i, '$1:***@');
}
