import { ApplyError, type SyncContext } from './apply.js';
import { AGENT_VERSION, type Config } from './config.js';
import {
  AgentLock,
  countExecuting,
  createDb,
  hasUnsent,
  heartbeat,
  looksLikeCentralDb,
  NotQuietError,
  outboxCounts,
  readState,
  setPause,
  writeState,
  type Db,
} from './db.js';
import type { Logger } from './logger.js';
import { maintain } from './maintenance.js';
import { Pusher, resetPushing } from './outbox.js';
import { pull, type PullOptions, type PullSummary } from './pull.js';
import { rebase } from './rebase.js';
import { loadCatalog, SchemaError, SyncSchema, type Catalog } from './schema.js';
import { NewWritesError, snapshot } from './snapshot.js';
import { localInfo, Upstream, UpstreamError, type Hello, type LocalInfo } from './upstream.js';

export const PROTOCOL = 1;
/** Yazma duraklatması süresi; ajan sürdükçe yeniler, çökerse kendiliğinden kalkar. */
const PAUSE_SECONDS = 30;
const PAUSE_RENEW_MS = 10_000;
/** Duraklatmadan sonra yerel sunucunun yarım işlerini bekleme süresi. */
const EXECUTING_WAIT_MS = 15_000;
const HEARTBEAT_MS = 10_000;
const CLOCK_SKEW_MS = 2 * 60_000;
/** Bir turda çekme sınırı: duraklatma (yerel yazmalar bekler) kısa kalsın. */
const PULL_MAX_PAGES = 20;
const PULL_BUDGET_MS = 8_000;
/**
 * Bir turda gönderilecek parti sınırı: duraklatmadan önce (yoğun dükkânda
 * sürekli yeni işlem gelse de geri alma/çekme aç kalmasın) ve duraklatılmışken.
 */
const OPEN_PUSH_BATCHES = 20;
const PAUSED_PUSH_BATCHES = 3;
const MAINTENANCE_EVERY_MS = 24 * 3_600_000;
const MAINTENANCE_FIRST_MS = 15 * 60_000;

/** Ajanın sürdürülemeyeceği durum (süreç kapanır, kişi müdahale etmeli). */
export class FatalError extends Error {}

/** Üstel bekleme + jitter: 2 → 4 → 8 … sn, üst sınır `maxSeconds`. */
export function backoffMs(failures: number, maxSeconds: number, random: () => number = Math.random): number {
  const base = Math.min(2 ** Math.max(1, failures), maxSeconds) * 1000;
  return Math.min(Math.round(base * (0.8 + random() * 0.4)), maxSeconds * 1000);
}

/** Hatayı kişinin anlayacağı tek satırlık Türkçe açıklamaya çevirir. */
export function describeError(err: unknown): string {
  const e = err as Error & { code?: string };
  let text: string;
  if (err instanceof UpstreamError) {
    switch (err.kind) {
      case 'network':
      case 'timeout':
        text = `Merkez sunucuya ulaşılamıyor (${err.message}). Yerel sunucu çalışmaya devam ediyor; bağlantı gelince eşitlenecek.`;
        break;
      case 'server':
        text = `Merkez sunucu şu an yanıt veremiyor (${err.message}); yeniden denenecek.`;
        break;
      case 'auth':
        text = `Merkez bu yerel sunucunun anahtarını kabul etmedi (${err.message}). Merkezde Ayarlar › Yerel sunucular'dan anahtarı kontrol edin; gerekirse yenisini üretip REPLICA_TOKEN'a girin ve ajanı yeniden başlatın.`;
        break;
      case 'protocol':
        text = `Merkezden beklenmedik yanıt (${err.message}). Merkez ve ajan sürümlerini kontrol edin.`;
        break;
      default:
        text = `Merkez isteği kabul etmedi (${err.message}).`;
    }
  } else if (err instanceof ApplyError || err instanceof SchemaError || err instanceof NotQuietError || err instanceof NewWritesError || err instanceof FatalError) {
    text = e.message;
  } else if (typeof e?.code === 'string' && (/^E[A-Z]+$/.test(e.code) || e.code.startsWith('57P') || e.code.startsWith('08'))) {
    text = `Yerel veritabanına ulaşılamıyor (${e.code}${e.message ? `: ${e.message}` : ''}). Yerel PostgreSQL'i ve REPLICA_DB_URL'yi kontrol edin.`;
  } else if (typeof e?.code === 'string' && e.code === '28P01') {
    text = `Yerel veritabanı parolası kabul edilmedi. REPLICA_DB_URL'yi kontrol edin.`;
  } else {
    text = `Beklenmedik hata: ${e?.message ?? String(err)}`;
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 1000);
}

type TourResult =
  | { kind: 'ok'; more: boolean }
  | { kind: 'offline' } // merkez yok/meşgul: üstel bekle
  | { kind: 'blocked' } // kişi müdahalesi gerekiyor: seyrek yeniden dene
  | { kind: 'error' }; // beklenmedik: üstel bekle

export interface Health {
  ok: boolean;
  upstream: boolean;
  pending: number;
  rejected: number;
  uncertain: number;
  lastSeq: string | null;
  lastError: string | null;
  lastTourAt: string | null;
  version: string;
}

/**
 * Eşitleme ajanı: tek süreç, tek döngü (docs/SYNC.md § 7, ana talimat § 6.3).
 *
 *   nabız → yerel bilgi + hello → (merkez yoksa: durum yaz, üstel bekle)
 *   gönder (duraklatmadan; çevrimdışı biriken çok işlem yerel yazmaları bekletmesin)
 *   duraklat → 300 ms → executing bitene kadar bekle (≤15 sn)
 *   kalanları gönder → hiç bekleyen yoksa: rebase → çek
 *   duraklatmayı kaldır (finally) → durum yaz
 */
export class Agent {
  readonly db: Db;
  private readonly upstream: Upstream;
  private readonly lock: AgentLock;
  private readonly pusher: Pusher;
  private schema: SyncSchema | null = null;
  private catalog: Catalog | null = null;

  private stopping = false;
  private wake: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatBusy = false;
  private failures = 0;
  private upstreamReachable = false;
  private lastError: string | null = null;
  private lastTourAt: number | null = null;
  private blocked = false;
  private centralChecked = false;
  private maintenanceAt: number = Date.now() - MAINTENANCE_EVERY_MS + MAINTENANCE_FIRST_MS;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly startupWarnings: string[] = [],
  ) {
    this.db = createDb(config.replicaDbUrl, log);
    this.upstream = new Upstream(config.upstreamUrl, config.replicaToken);
    this.lock = new AgentLock(this.db, log);
    this.pusher = new Pusher(this.db, this.upstream, log);
  }

  /** Döngüyü başlatır; `stop()` ya da ölümcül hata ile biter. */
  start(): Promise<void> {
    this.running ??= this.run();
    return this.running;
  }

  /** Turu güvenle bitirir, duraklatmayı kaldırır, kilidi bırakır. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running?.catch(() => undefined);
  }

  private async run(): Promise<void> {
    try {
      await this.connect();
      this.heartbeatTimer = setInterval(() => void this.beat(), HEARTBEAT_MS);
      await this.beat();
      while (!this.stopping) {
        const result = await this.tour();
        this.lastTourAt = Date.now();
        if (this.stopping) break;
        if (result.kind === 'ok') await this.maybeMaintain();
        await this.sleep(this.delayAfter(result));
      }
    } finally {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      await this.lock.release().catch(() => undefined);
      await this.db.end().catch(() => undefined);
    }
  }

  private delayAfter(result: TourResult): number {
    const max = this.config.maxBackoffSeconds;
    switch (result.kind) {
      case 'ok':
        this.failures = 0;
        return result.more ? 200 : this.config.intervalSeconds * 1000;
      case 'blocked':
        this.failures = 0;
        return max * 1000;
      default:
        this.failures++;
        return backoffMs(this.failures, max);
    }
  }

  /** Veritabanına bağlanır (yoksa bekleyerek), güvenlik denetimleri ve kilit. */
  private async connect(): Promise<void> {
    for (let attempt = 1; !this.stopping; attempt++) {
      try {
        if (await looksLikeCentralDb(this.db)) {
          throw new FatalError(
            'REPLICA_DB_URL merkez sunucunun veritabanını gösteriyor (yerel sunucu anahtarları burada). Ajan bu veritabanına yazmaz; adresi yerel sunucunun veritabanıyla değiştirin.',
          );
        }
        if (!(await this.lock.acquire())) {
          throw new FatalError('Bu veritabanında başka bir eşitleme ajanı zaten çalışıyor; bu kopya kapanıyor.');
        }
        const n = await resetPushing(this.db);
        if (n) this.log.info('outbox.reset', `Yarıda kalan ${n} gönderim yeniden gönderilecek.`);
        for (const w of this.startupWarnings) this.log.warn('config.warning', w);
        return;
      } catch (err) {
        if (err instanceof FatalError) throw err;
        const delay = backoffMs(attempt, this.config.maxBackoffSeconds);
        this.log.warn('db.unreachable', `${describeError(err)} ${Math.round(delay / 1000)} sn sonra yeniden denenecek.`);
        await this.sleep(delay);
      }
    }
  }

  private async beat(): Promise<void> {
    if (this.heartbeatBusy) return;
    this.heartbeatBusy = true;
    try {
      await heartbeat(this.db, AGENT_VERSION);
    } catch (err) {
      this.log.debug('heartbeat.failed', describeError(err));
    } finally {
      this.heartbeatBusy = false;
    }
  }

  /** Bir eşitleme turu; sonucu sonraki bekleme süresini belirler. */
  async tour(): Promise<TourResult> {
    const warnings: string[] = [];
    try {
      if (!this.lock.held && !(await this.lock.acquire())) {
        throw new FatalError('Bu veritabanında başka bir eşitleme ajanı çalışıyor; bu kopya kapanıyor.');
      }
      await resetPushing(this.db);

      let info: LocalInfo;
      try {
        info = await localInfo(this.config.localApiUrl);
      } catch (err) {
        const text = `Yerel sunucuya ulaşılamıyor (${this.config.localApiUrl}: ${(err as Error).message}); eşitleme bekliyor.`;
        if (this.lastError !== text) this.log.warn('local.unreachable', text);
        this.lastError = text;
        await this.status({ last_error: text });
        return { kind: 'offline' };
      }
      if (info.role !== 'replica') {
        return this.block(`LOCAL_API_URL'deki sunucu yerel sunucu (replika) değil (rol: ${info.role}); eşitleme yapılmıyor.`);
      }

      let hello: Hello;
      try {
        hello = await this.upstream.hello();
      } catch (err) {
        if (err instanceof UpstreamError && err.transient) {
          const wasReachable = this.upstreamReachable;
          this.upstreamReachable = false;
          const text = describeError(err);
          await this.status({ upstream_reachable: false, last_error: text });
          if (wasReachable || this.failures === 0) this.log.warn('upstream.unreachable', text);
          return { kind: 'offline' };
        }
        if (err instanceof UpstreamError && err.kind === 'auth') return this.block(describeError(err));
        throw err;
      }
      if (!this.upstreamReachable) this.log.info('upstream.reachable', `Merkeze bağlanıldı (${this.upstream.baseUrl}).`);
      this.upstreamReachable = true;
      await this.status({ upstream_reachable: true, last_contact_at: new Date() });

      const problem = await this.checkIdentity(hello, info, warnings);
      if (problem) return this.block(problem);
      const ctx = await this.context(hello);

      const state = await readState(this.db);
      const restored =
        state.last_seq != null &&
        BigInt(hello.seq) < BigInt(state.last_seq) &&
        BigInt(hello.prunedSeq) < BigInt(state.last_seq);
      let more = false;
      if (!state.snapshot_at || state.last_seq == null) {
        await this.load(ctx, hello, state.last_seq == null ? 'İlk yükleme' : 'İstenen baştan yükleme');
      } else if (restored) {
        await this.load(ctx, hello, `Merkezin imleci geriledi (${state.last_seq} → ${hello.seq}; yedekten dönülmüş olabilir), baştan yükleme`);
      } else {
        more = await this.syncOnce(ctx, hello);
      }

      this.blocked = false;
      this.lastError = warnings.length ? warnings.join(' · ') : null;
      await this.status({ last_error: this.lastError });
      return { kind: 'ok', more };
    } catch (err) {
      if (err instanceof FatalError) throw err;
      const text = describeError(err);
      if (err instanceof NotQuietError || err instanceof NewWritesError) {
        this.log.info('tour.deferred', text);
        return { kind: 'ok', more: true };
      }
      this.lastError = text;
      if (err instanceof UpstreamError && err.kind === 'auth') return this.block(text);
      if (err instanceof UpstreamError && err.transient) {
        this.upstreamReachable = false;
        await this.status({ upstream_reachable: false, last_error: text }).catch(() => undefined);
        this.log.warn('upstream.unreachable', text);
        return { kind: 'offline' };
      }
      this.log.error('tour.failed', text, { error: (err as Error)?.stack ?? String(err) });
      await this.status({ last_error: text }).catch(() => undefined);
      return { kind: 'error' };
    }
  }

  /** Kişi müdahalesi gerektiren durum: eşitleme yapılmaz, nabız sürer, seyrek yeniden denenir. */
  private async block(text: string): Promise<TourResult> {
    if (!this.blocked || this.lastError !== text) this.log.error('sync.blocked', text);
    this.blocked = true;
    this.lastError = text;
    await this.status({ last_error: text }).catch(() => undefined);
    return { kind: 'blocked' };
  }

  /** Merkez ve yerel aynı sürümde mi, doğru merkez mi, saatler yakın mı? */
  private async checkIdentity(hello: Hello, info: LocalInfo, warnings: string[]): Promise<string | null> {
    if (hello.protocol !== PROTOCOL) {
      return `Protokol farkı: merkez ${hello.protocol}, ajan ${PROTOCOL}. Ajanı merkezle uyumlu sürüme güncelleyin.`;
    }
    if (hello.role !== 'primary') return `UPSTREAM_URL merkez sunucuyu göstermiyor (rol: ${hello.role}).`;
    if (hello.schemaHash !== info.schemaHash) {
      return `Sürüm farkı: merkez ${hello.schemaHash}, yerel ${info.schemaHash}. İkisini aynı sürüme getirin.`;
    }
    if (!this.centralChecked) {
      if (await looksLikeCentralDb(this.db, hello.serverId)) {
        throw new FatalError('REPLICA_DB_URL merkez sunucunun veritabanını gösteriyor. Ajan bu veritabanına yazmaz; adresi düzeltin.');
      }
      this.centralChecked = true;
      this.log.info(
        'upstream.hello',
        `Merkez: ${hello.serverId} · yerel sunucu kaydı "${hello.replica.name}" · dükkânlar: ${hello.replica.shopIds.length ? hello.replica.shopIds.length : 'hepsi'}`,
      );
    }
    const state = await readState(this.db);
    if (state.upstream_server_id && state.upstream_server_id !== hello.serverId) {
      return `Farklı bir merkeze bağlanılıyor: kayıtlı merkez ${state.upstream_server_id}, bu adresteki ${hello.serverId}. UPSTREAM_URL'yi düzeltin; merkez gerçekten değiştiyse yerel veritabanını sıfırlayıp baştan kurun.`;
    }
    if (!state.upstream_server_id) await writeState(this.db, { upstream_server_id: hello.serverId });
    const skew = Date.parse(hello.serverTime) - Date.parse(info.serverTime ?? new Date().toISOString());
    if (Number.isFinite(skew) && Math.abs(skew) > CLOCK_SKEW_MS) {
      warnings.push(
        `Saat farkı: bu bilgisayarın saati merkezden ${Math.round(Math.abs(skew) / 60_000)} dk ${skew > 0 ? 'geri' : 'ileri'}; yerel işlemler bu saatle kaydedilir. Bilgisayarın saatini düzeltin.`,
      );
    }
    return null;
  }

  /** Şema (özet değişince yeniden) ve yerel katalog. */
  private async context(hello: Hello): Promise<SyncContext> {
    if (!this.schema || !this.catalog || this.schema.hash !== hello.schemaHash) {
      const res = await this.upstream.schema();
      if (res.schemaHash !== hello.schemaHash) throw new SchemaError('Merkez şeması tur sırasında değişti; yeniden denenecek.');
      const schema = new SyncSchema(res);
      this.catalog = await loadCatalog(this.db, schema);
      this.schema = schema;
      this.log.info('schema.loaded', `Eşitlenen tablo: ${schema.tables.length} (şema ${schema.hash}).`);
    }
    return { db: this.db, upstream: this.upstream, schema: this.schema, catalog: this.catalog, log: this.log };
  }

  /** Olağan tur: gönder → (duraklat) kalanları gönder → rebase → çek. true: çekilecek daha var. */
  private async syncOnce(ctx: SyncContext, hello: Hello): Promise<boolean> {
    this.logPush(await this.pusher.pushAll(OPEN_PUSH_BATCHES));
    let resnapshot: string | null = null;
    const more = await this.withPause(async () => {
      if (!(await this.waitExecuting())) {
        // Normal aralıkla yeniden denenir: yerel yazmalar sürekli bekletilmesin.
        this.log.info('tour.busy', 'Yerel sunucuda süren işlem var; geri alma ve çekme sonraki tura kaldı.');
        return false;
      }
      const pushed = await this.pusher.pushAll(PAUSED_PUSH_BATCHES);
      this.logPush(pushed);
      if (pushed.blocked) return false; // merkez "sonra" dedi: normal aralıkla
      if (await hasUnsent(this.db)) return true; // gönderilecek daha var: hemen yeni tur
      const rb = await rebase(ctx);
      if (rb && rb.rows) {
        this.log.info(
          'rebase.done',
          `Yerel değişiklikler merkezdeki hale getirildi: ${rb.rows} satır (${rb.upserted} güncellendi, ${rb.deleted} silindi${rb.repaired ? `, ${rb.repaired} onarıldı` : ''}).`,
          { ...rb },
        );
      }
      try {
        const p = await pull(ctx, this.pullOptions(hello));
        this.logPull(p);
        return p.more;
      } catch (err) {
        if (err instanceof UpstreamError && err.kind === 'resnapshot') {
          resnapshot =
            err.status === 410
              ? 'Merkezin değişiklik günlüğü bu yerel sunucunun imlecinden eski kısmı silmiş (410), baştan yükleme'
              : `Değişiklikler güvenle çekilemiyor (${err.message}), baştan yükleme`;
          return false;
        }
        throw err;
      }
    });
    if (resnapshot) {
      await this.load(ctx, hello, resnapshot);
      return true;
    }
    return more;
  }

  /** İlk yükleme / baştan yükleme: önce bekleyen işlemler gönderilir, giden kutusu korunur. */
  private async load(ctx: SyncContext, hello: Hello, reason: string): Promise<void> {
    this.log.info('snapshot.start', `${reason} başlıyor…`);
    this.logPush(await this.pusher.pushAll());
    await this.withPause(async () => {
      if (!(await this.waitExecuting())) throw new NotQuietError();
      const pushed = await this.pusher.pushAll();
      this.logPush(pushed);
      if (pushed.blocked || (await hasUnsent(this.db))) {
        throw new UpstreamError('server', 'bekleyen işlemler gönderilemedi; yükleme ertelendi');
      }
      // seq0 yüklemeden ÖNCE alınır: arada değişenler sonra yeniden gelir (zararsız).
      const fresh = await this.upstream.hello();
      if (fresh.serverId !== hello.serverId || fresh.schemaHash !== hello.schemaHash) {
        throw new SchemaError('Merkez yükleme başlarken değişti; yeniden denenecek.');
      }
      // Günlük tamamen budanmışsa merkez seq=0 der ama prunedSeq'ten gerisi 410 olur.
      const seq0 = BigInt(fresh.seq) > BigInt(fresh.prunedSeq) ? fresh.seq : fresh.prunedSeq;
      const s = await snapshot(ctx, { seq0, serverId: fresh.serverId });
      this.log.info('snapshot.done', `${reason} bitti: ${s.rows} satır, ${s.tables} tablo, ${(s.ms / 1000).toFixed(1)} sn.`, { ...s });
      this.logPull(await pull(ctx, this.pullOptions(fresh)));
    });
  }

  private pullOptions(hello: Hello): PullOptions {
    return { maxPages: PULL_MAX_PAGES, budgetMs: PULL_BUDGET_MS, sleep: (ms) => this.sleep(ms), upstreamSeq: hello.seq };
  }

  private logPull(p: PullSummary): void {
    if (!p.changes) return;
    const repaired = p.repaired ? `; sayfa sınırındaki ${p.repaired} satır merkezden ayrıca alınıp onarıldı` : '';
    this.log.info('pull.done', `Merkezden ${p.changes} değişiklik alındı (imleç ${p.lastSeq}${repaired}).`, { ...p });
  }

  private logPush(p: { sent: number; applied: number; rejected: number; blocked: boolean }): void {
    if (!p.sent) return;
    const text = `Merkeze gönderildi: ${p.sent} işlem (${p.applied} uygulandı${p.rejected ? `, ${p.rejected} reddedildi` : ''}${p.blocked ? ', kalanlar sonra yeniden' : ''}).`;
    this.log.info('push.done', text, { ...p });
  }

  /**
   * Yerel yazmaları duraklatır (en çok 30 sn, sürdükçe yenilenir); iş bitince
   * ya da hata olunca kaldırılır. Ajan ölürse süre dolunca kendiliğinden kalkar.
   */
  private async withPause<T>(fn: () => Promise<T>): Promise<T> {
    await setPause(this.db, PAUSE_SECONDS);
    const timer = setInterval(() => {
      setPause(this.db, PAUSE_SECONDS).catch((err) => this.log.warn('pause.renew_failed', describeError(err)));
    }, PAUSE_RENEW_MS);
    try {
      // Duraklatmadan hemen önce açılmış bir yerel işlemin kaydı görünür olsun.
      await new Promise((r) => setTimeout(r, 300));
      return await fn();
    } finally {
      clearInterval(timer);
      await setPause(this.db, null).catch((err) => this.log.warn('pause.clear_failed', describeError(err)));
    }
  }

  /** Yerel sunucunun yarım işleri (executing) bitene kadar bekler. */
  private async waitExecuting(): Promise<boolean> {
    const deadline = Date.now() + EXECUTING_WAIT_MS;
    while ((await countExecuting(this.db)) > 0) {
      if (Date.now() > deadline || this.stopping) return false;
      await new Promise((r) => setTimeout(r, 200));
    }
    return true;
  }

  private async maybeMaintain(): Promise<void> {
    if (Date.now() - this.maintenanceAt < MAINTENANCE_EVERY_MS) return;
    this.maintenanceAt = Date.now();
    try {
      const m = await maintain(this.db);
      this.log.info(
        'maintenance.done',
        `Bakım: yerel günlükten ${m.changes}, giden kutusundan ${m.outbox}, tekrar korumasından ${m.idempotency} eski kayıt silindi.`,
        { ...m },
      );
    } catch (err) {
      this.log.warn('maintenance.failed', `Bakım yapılamadı: ${describeError(err)}`);
    }
  }

  private async status(fields: Record<string, unknown>): Promise<void> {
    await writeState(this.db, { upstream_url: this.config.upstreamUrl, ...fields });
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wake = done;
    });
  }

  /** Durum ucu için özet. */
  async health(): Promise<Health> {
    const [counts, state] = await Promise.all([outboxCounts(this.db), readState(this.db)]);
    const staleAfter = 3 * Math.max(this.config.intervalSeconds, this.config.maxBackoffSeconds) * 1000 + 60_000;
    return {
      ok: !this.blocked && this.lastTourAt != null && Date.now() - this.lastTourAt < staleAfter,
      upstream: this.upstreamReachable,
      pending: (counts.executing ?? 0) + (counts.pending ?? 0) + (counts.pushing ?? 0),
      rejected: counts.rejected ?? 0,
      uncertain: counts.uncertain ?? 0,
      lastSeq: state.last_seq,
      lastError: this.lastError,
      lastTourAt: this.lastTourAt ? new Date(this.lastTourAt).toISOString() : null,
      version: AGENT_VERSION,
    };
  }
}
