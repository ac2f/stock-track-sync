import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(event: string, msg: string, fields?: Record<string, unknown>): void;
  info(event: string, msg: string, fields?: Record<string, unknown>): void;
  warn(event: string, msg: string, fields?: Record<string, unknown>): void;
  error(event: string, msg: string, fields?: Record<string, unknown>): void;
}

const KEEP_DAYS = 7;
const FILE_RE = /^sync-(\d{4}-\d{2}-\d{2})\.log$/;

/** Yerel tarih (dosya adı ve döndürme bu tarihe göre). */
function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Günlük: dosyaya JSON satırları (günlük döner, 7 gün saklanır), konsola kısa
 * özet. `secrets` içindeki metinler (anahtar, veritabanı parolası) her satırda
 * maskelenir — yanlışlıkla bir hata mesajına karışsalar bile dosyaya girmez.
 */
export function createLogger(opts: {
  dir: string | null;
  secrets?: string[];
  console?: boolean;
  debug?: boolean;
}): Logger {
  const secrets = (opts.secrets ?? []).filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  const redact = (text: string): string => {
    let out = text.replace(/(postgres(?:ql)?:\/\/[^:/@\s]*):[^@\s]*@/gi, '$1:***@');
    for (const s of secrets) out = out.split(s).join(s.startsWith('str_') ? `${s.slice(0, 6)}…` : '***');
    return out;
  };

  let currentDay = '';
  let file: string | null = null;
  if (opts.dir) {
    try {
      mkdirSync(opts.dir, { recursive: true });
    } catch {
      opts.dir = null;
    }
  }

  const rotate = (now: Date): void => {
    if (!opts.dir) return;
    const day = localDate(now);
    if (day === currentDay) return;
    currentDay = day;
    file = join(opts.dir, `sync-${day}.log`);
    const limit = now.getTime() - KEEP_DAYS * 86_400_000;
    try {
      for (const name of readdirSync(opts.dir)) {
        if (!FILE_RE.test(name)) continue;
        const path = join(opts.dir, name);
        if (statSync(path).mtimeMs < limit) unlinkSync(path);
      }
    } catch {
      // Eski günlük silinemezse çalışmaya devam (bir sonraki gün yeniden denenir).
    }
  };

  const write = (level: Level, event: string, msg: string, fields?: Record<string, unknown>): void => {
    if (level === 'debug' && !opts.debug) return;
    const now = new Date();
    const line = redact(
      JSON.stringify({ time: now.toISOString(), level, event, msg, ...fields }, (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v instanceof Error ? v.message : v,
      ),
    );
    if (opts.dir) {
      rotate(now);
      try {
        appendFileSync(file!, line + '\n');
      } catch {
        // Disk dolu/izin yok: konsola yazmaya devam edilir.
      }
    }
    if (opts.console !== false) {
      const text = redact(msg);
      const stamp = now.toTimeString().slice(0, 8);
      const tag = level === 'info' ? '' : ` ${level.toUpperCase()}`;
      const out = `${stamp}${tag} ${text}`;
      if (level === 'error' || level === 'warn') console.error(out);
      else console.log(out);
    }
  };

  return {
    debug: (e, m, f) => write('debug', e, m, f),
    info: (e, m, f) => write('info', e, m, f),
    warn: (e, m, f) => write('warn', e, m, f),
    error: (e, m, f) => write('error', e, m, f),
  };
}
