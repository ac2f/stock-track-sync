import { z } from 'zod';
import { AGENT_VERSION } from './config.js';

/**
 * Merkez ve yerel sunucuyla HTTP konuşması (docs/SYNC.md § 4–5). Yanıtlar
 * `{ success, data }` zarfındadır; `data` şemayla doğrulanır — beklenmedik
 * bir yanıt veritabanına yazılmadan önce yakalanır.
 */

export type UpstreamErrorKind =
  | 'network' // bağlantı kurulamadı / koptu
  | 'timeout'
  | 'auth' // 401/403: anahtar geçersiz, kapalı ya da adres yerel sunucuyu gösteriyor
  | 'resnapshot' // 410 RESNAPSHOT
  | 'bad_request' // 400: şema/parametre
  | 'too_large' // 413: istek gövdesi sınırı
  | 'server' // 5xx, 408, 429
  | 'http' // diğer kodlar
  | 'protocol'; // yanıt beklenen biçimde değil

export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }

  /** Geçici mi (merkez yok/meşgul: bekle, yeniden dene)? */
  get transient(): boolean {
    return this.kind === 'network' || this.kind === 'timeout' || this.kind === 'server';
  }
}

const seqText = z.string().regex(/^\d{1,19}$/);
const uuid = z.string().uuid();
const row = z.record(z.unknown()).refine((r) => typeof r.id === 'string' && uuid.safeParse(r.id).success, {
  message: 'satırın id alanı uuid değil',
});
export type Row = Record<string, unknown> & { id: string };

export const helloSchema = z.object({
  protocol: z.number(),
  serverId: uuid,
  role: z.string(),
  schemaHash: z.string().min(1),
  seq: seqText,
  prunedSeq: seqText,
  serverTime: z.string(),
  replica: z.object({ id: z.string(), name: z.string(), shopIds: z.array(z.string()) }),
});
export type Hello = z.infer<typeof helloSchema>;

export const schemaSchema = z.object({
  schemaHash: z.string().min(1),
  tables: z.array(
    z.object({
      name: z.string(),
      scope: z.string(),
      order: z.number().int(),
      dependsOn: z.array(z.string()).default([]),
      columns: z.array(z.object({ name: z.string(), type: z.string().optional() })),
    }),
  ),
});
export type SchemaResponse = z.infer<typeof schemaSchema>;

const snapshotSchema = z.object({
  table: z.string(),
  rows: z.array(row),
  nextAfterId: z.string().nullable(),
  done: z.boolean(),
});

export const changeSchema = z.object({
  seq: seqText,
  table: z.string(),
  id: uuid,
  op: z.enum(['upsert', 'delete']),
  row: row.nullable(),
});
export type Change = z.infer<typeof changeSchema>;

const changesSchema = z.object({
  changes: z.array(changeSchema),
  lastSeq: seqText,
  hasMore: z.boolean(),
  waiting: z.boolean(),
});

const rowsSchema = z.object({ table: z.string(), rows: z.array(row), missing: z.array(uuid) });

export const pushResultSchema = z.object({
  opId: z.string(),
  outcome: z.enum(['applied', 'duplicate', 'rejected', 'retry', 'skipped']),
  httpStatus: z.number().optional(),
  body: z.unknown().optional(),
  error: z.string().optional(),
  created: z
    .object({
      inserted: z.array(z.object({ table: z.string(), id: z.string() })).default([]),
      docNos: z.record(z.string()).default({}),
    })
    .optional(),
});
export type PushResult = z.infer<typeof pushResultSchema>;
const pushSchema = z.object({ results: z.array(pushResultSchema) });

export interface PushOp {
  opId: string;
  actor: 'user' | 'corel';
  userId: string | null;
  shopId: string | null;
  method: string;
  path: string;
  body: unknown;
  occurredAt: string;
  clientIds: { table: string; id: string }[];
  docNos: Record<string, string>;
}

const infoSchema = z.object({
  role: z.string(),
  version: z.string().optional(),
  schemaHash: z.string(),
  ready: z.boolean().optional(),
  serverTime: z.string().optional(),
});
export type LocalInfo = z.infer<typeof infoSchema>;

/** Zaman aşımları (ms): bağlantı denemesi kısa, gönderim uzun (merkez her işlemi yeniden işler). */
export const TIMEOUTS = { hello: 5_000, read: 30_000, push: 120_000, local: 5_000 } as const;

async function request<T>(
  base: string,
  method: 'GET' | 'POST',
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  opts: { headers?: Record<string, string>; body?: unknown; timeoutMs: number },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers: {
        Accept: 'application/json',
        'User-Agent': `stocktrack-sync/${AGENT_VERSION}`,
        ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new UpstreamError('timeout', `${Math.round(opts.timeoutMs / 1000)} sn içinde yanıt gelmedi`);
    }
    throw new UpstreamError('network', e.cause?.code ?? e.cause?.message ?? e.message);
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new UpstreamError('network', `yanıt yarıda kesildi (${(err as Error).message})`);
  }
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const body = (parsed ?? {}) as { message?: unknown; code?: unknown };
    const message = Array.isArray(body.message)
      ? body.message.join(' · ')
      : typeof body.message === 'string'
        ? body.message
        : text.slice(0, 200) || res.statusText;
    const code = typeof body.code === 'string' ? body.code : undefined;
    const s = res.status;
    const kind: UpstreamErrorKind =
      s === 401 || s === 403
        ? 'auth'
        : s === 410 && code === 'RESNAPSHOT'
          ? 'resnapshot'
          : s === 400
            ? 'bad_request'
            : s === 413
              ? 'too_large'
              : s >= 500 || s === 408 || s === 429
                ? 'server'
                : 'http';
    throw new UpstreamError(kind, `${s} ${message}`, s, code);
  }

  const envelope = parsed as { success?: unknown; data?: unknown } | null;
  if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) {
    throw new UpstreamError('protocol', `${path}: yanıt beklenen biçimde değil`);
  }
  const result = schema.safeParse(envelope.data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new UpstreamError('protocol', `${path}: yanıt beklenen biçimde değil (${issue?.path.join('.')}: ${issue?.message})`);
  }
  return result.data;
}

/** Merkezin `/sync/*` uçları (yerel sunucu anahtarıyla). */
export class Upstream {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private get<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, timeoutMs: number): Promise<T> {
    return request(this.baseUrl, 'GET', path, schema, { headers: { 'X-Replica-Token': this.token }, timeoutMs });
  }

  private post<T>(path: string, body: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>, timeoutMs: number): Promise<T> {
    return request(this.baseUrl, 'POST', path, schema, { headers: { 'X-Replica-Token': this.token }, body, timeoutMs });
  }

  hello(): Promise<Hello> {
    return this.get('/sync/hello', helloSchema, TIMEOUTS.hello);
  }

  schema(): Promise<SchemaResponse> {
    return this.get('/sync/schema', schemaSchema, TIMEOUTS.read);
  }

  snapshot(table: string, afterId: string | null, limit: number) {
    const q = new URLSearchParams({ table, limit: String(limit) });
    if (afterId) q.set('afterId', afterId);
    return this.get(`/sync/snapshot?${q}`, snapshotSchema, TIMEOUTS.read) as Promise<{
      table: string;
      rows: Row[];
      nextAfterId: string | null;
      done: boolean;
    }>;
  }

  changes(since: string, limit: number) {
    return this.get(`/sync/changes?since=${since}&limit=${limit}`, changesSchema, TIMEOUTS.read);
  }

  rows(table: string, ids: string[]) {
    return this.post('/sync/rows', { table, ids }, rowsSchema, TIMEOUTS.read) as Promise<{
      table: string;
      rows: Row[];
      missing: string[];
    }>;
  }

  push(ops: PushOp[]) {
    return this.post('/sync/push', { ops }, pushSchema, TIMEOUTS.push);
  }
}

/** Yerel sunucunun oturumsuz bilgi ucu (yalnız rol ve şema özeti için). */
export function localInfo(localApiUrl: string): Promise<LocalInfo> {
  return request(localApiUrl, 'GET', '/system/info', infoSchema, { timeoutMs: TIMEOUTS.local });
}
