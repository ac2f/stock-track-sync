import { createServer, type Server } from 'node:http';
import type { Health } from './loop.js';
import type { Logger } from './logger.js';

/**
 * İsteğe bağlı durum ucu: yalnız 127.0.0.1'de `GET /health`. Docker sağlık
 * denetimi ve kurulum betiği kullanır; anahtar ya da veri içermez.
 */
export function startStatusServer(port: number, health: () => Promise<Health>, log: Logger): Server | null {
  if (!port) return null;
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url?.split('?')[0] !== '/health') {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    health().then(
      (h) => res.writeHead(h.ok ? 200 : 503, { 'Content-Type': 'application/json' }).end(JSON.stringify(h)),
      (err: Error) =>
        res
          .writeHead(503, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ ok: false, lastError: `Yerel veritabanı okunamadı: ${err.message}` })),
    );
  });
  server.on('error', (err) => log.warn('status.failed', `Durum ucu açılamadı (127.0.0.1:${port}): ${err.message}`));
  server.listen(port, '127.0.0.1', () => log.debug('status.listening', `Durum ucu: http://127.0.0.1:${port}/health`));
  return server;
}
