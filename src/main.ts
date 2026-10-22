#!/usr/bin/env node
import { AGENT_VERSION, ConfigError, loadConfig, maskDbUrl, maskToken, type Config } from './config.js';
import { createDb, looksLikeCentralDb, outboxCounts, readState } from './db.js';
import { createLogger } from './logger.js';
import { Agent, describeError, FatalError } from './loop.js';
import { startStatusServer } from './status.js';
import { localInfo, Upstream } from './upstream.js';

/** Çıkış kodları: 1 ayar/beklenmedik hata, 2 kişi müdahalesi (yeniden başlatmak çözmez). */
const EXIT_FATAL = 2;
const SHUTDOWN_GRACE_MS = 30_000;

const args = new Set(process.argv.slice(2));

if (args.has('--version')) {
  console.log(AGENT_VERSION);
  process.exit(0);
}

let loaded: ReturnType<typeof loadConfig>;
try {
  loaded = loadConfig();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : `Ayarlar okunamadı: ${(err as Error).message}`);
  console.error('Ayrıntı: README.md › Ayarlar');
  process.exit(1);
}
const { config, warnings, file } = loaded;

if (args.has('--check')) {
  process.exit(await check(config, warnings));
}

if (args.has('--resnapshot')) {
  process.exit(await requestResnapshot(config));
}

const log = createLogger({
  dir: config.logDir,
  secrets: [config.replicaToken, config.replicaDbUrl],
  debug: process.env.LOG_LEVEL === 'debug',
});
log.info(
  'agent.start',
  `StockTrack eşitleme ajanı ${AGENT_VERSION} başlıyor · merkez ${config.upstreamUrl} · anahtar ${maskToken(config.replicaToken)} · yerel veritabanı ${maskDbUrl(config.replicaDbUrl)}${file ? ` · ayar dosyası ${file}` : ''}`,
);

const agent = new Agent(config, log, warnings);
const status = startStatusServer(config.statusPort, () => agent.health(), log);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info('agent.stop', `${signal} alındı; tur bitiriliyor, duraklatma kaldırılıyor…`);
  const force = setTimeout(() => {
    log.warn('agent.stop_forced', 'Tur zamanında bitmedi; kapanılıyor (duraklatma en çok 30 sn içinde kendiliğinden kalkar).');
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  force.unref();
  status?.close();
  await agent.stop();
  log.info('agent.stopped', 'Ajan durdu.');
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  log.error('agent.crash', `Beklenmedik hata: ${describeError(err)}`, { error: (err as Error)?.stack ?? String(err) });
  process.exit(1);
});

try {
  await agent.start();
  // Durdurma isteğiyle bittiyse çıkışı shutdown() yapar (son günlük satırı yazılsın).
  if (!stopping) process.exit(0);
} catch (err) {
  const fatal = err instanceof FatalError;
  log.error(fatal ? 'agent.fatal' : 'agent.crash', describeError(err), { error: (err as Error)?.stack ?? String(err) });
  process.exit(fatal ? EXIT_FATAL : 1);
}

/** `--check`: ayarlar, yerel veritabanı, yerel sunucu ve merkez bağlantısını dener (bir şey yazmaz). */
async function check(cfg: Config, warns: string[]): Promise<number> {
  const quiet = createLogger({ dir: null, console: false });
  let ok = true;
  const line = (good: boolean, text: string) => {
    if (!good) ok = false;
    console.log(`${good ? '[TAMAM]' : '[HATA] '} ${text}`);
  };
  for (const w of warns) console.log(`[UYARI] ${w}`);

  const db = createDb(cfg.replicaDbUrl, quiet);
  try {
    const central = await looksLikeCentralDb(db);
    const state = await readState(db);
    const counts = await outboxCounts(db);
    line(!central, central ? 'Yerel veritabanı merkezin veritabanı gibi görünüyor (REPLICA_DB_URL)' : `Yerel veritabanı: ${maskDbUrl(cfg.replicaDbUrl)}`);
    console.log(
      `        ilk yükleme: ${state.snapshot_at ? new Date(state.snapshot_at).toLocaleString('tr-TR') : 'yapılmadı'} · imleç: ${state.last_seq ?? '-'} · bekleyen: ${(counts.pending ?? 0) + (counts.pushing ?? 0)} · reddedilen: ${counts.rejected ?? 0} · belirsiz: ${counts.uncertain ?? 0}`,
    );
  } catch (err) {
    line(false, `Yerel veritabanı: ${describeError(err)}`);
  } finally {
    await db.end().catch(() => undefined);
  }

  let localHash: string | null = null;
  try {
    const info = await localInfo(cfg.localApiUrl);
    localHash = info.schemaHash;
    line(info.role === 'replica', `Yerel sunucu: ${cfg.localApiUrl} (rol: ${info.role}, sürüm ${info.version ?? '?'})`);
  } catch (err) {
    line(false, `Yerel sunucuya ulaşılamıyor: ${cfg.localApiUrl} (${(err as Error).message})`);
  }

  try {
    const hello = await new Upstream(cfg.upstreamUrl, cfg.replicaToken).hello();
    line(true, `Merkez: ${cfg.upstreamUrl} (kayıt "${hello.replica.name}", anahtar ${maskToken(cfg.replicaToken)})`);
    if (localHash) line(localHash === hello.schemaHash, `Şema: merkez ${hello.schemaHash}, yerel ${localHash}`);
  } catch (err) {
    line(false, describeError(err));
  }
  console.log(ok ? 'Her şey hazır.' : 'Sorunları düzeltip yeniden deneyin (README › Sorun giderme).');
  return ok ? 0 : 1;
}

/** `--resnapshot`: elle kurtarma. Çalışan ajan bir sonraki turda bekleyenleri gönderip baştan yükler. */
async function requestResnapshot(cfg: Config): Promise<number> {
  const db = createDb(cfg.replicaDbUrl, createLogger({ dir: null, console: false }));
  try {
    const { rowCount } = await db.query(`UPDATE replica_state SET snapshot_at = NULL, updated_at = now() WHERE id = 1`);
    console.log(
      rowCount
        ? 'Baştan yükleme istendi: ajan bir sonraki turda önce bekleyen işlemleri gönderecek, sonra yerel veriyi merkezden yeniden yükleyecek.'
        : 'Henüz ilk yükleme yapılmamış; ajan başlayınca zaten yükleyecek.',
    );
    return 0;
  } catch (err) {
    console.error(describeError(err));
    return 1;
  } finally {
    await db.end().catch(() => undefined);
  }
}
