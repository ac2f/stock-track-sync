import { createServer, type IncomingMessage, type Server } from 'node:http';

/**
 * Merkezin önündeki kaos vekili: ajan merkeze bunun üstünden konuşur. Test
 * bağlantıyı keser, istekleri geciktirir, yanıtı merkez işledikten SONRA
 * düşürür (ağ kesintisi gönderim ortasında) ya da hello yanıtını değiştirir.
 */
export class ChaosProxy {
  /** false: her bağlantı hemen kopar (merkez yok). */
  up = true;
  /** Bu kadar /sync/push yanıtı merkez işledikten sonra düşürülür. */
  dropPushResponses = 0;
  delays: { re: RegExp; ms: number }[] = [];
  /** İstek merkeze gitmeden önce (ör. ajanı tam o anda öldürmek için). */
  onRequest: ((path: string) => void) | null = null;
  rewriteHello: ((data: Record<string, unknown>) => Record<string, unknown>) | null = null;
  readonly seen: string[] = [];
  private server: Server | null = null;

  constructor(private readonly target: string) {}

  listen(port: number): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        (r) => {
          if (!r) return void req.socket.destroy();
          res.writeHead(r.status, r.headers).end(r.body);
        },
        () => req.socket.destroy(),
      );
    });
    return new Promise((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
  }

  close(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  reset(): void {
    this.up = true;
    this.dropPushResponses = 0;
    this.delays = [];
    this.onRequest = null;
    this.rewriteHello = null;
  }

  private async handle(req: IncomingMessage) {
    const path = req.url ?? '/';
    this.seen.push(`${req.method} ${path}`);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (!this.up) return null;
    this.onRequest?.(path);
    for (const d of this.delays) if (d.re.test(path)) await new Promise((r) => setTimeout(r, d.ms));
    if (!this.up) return null;

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string' && !['host', 'connection', 'content-length'].includes(k)) headers[k] = v;
    }
    const upstream = await fetch(this.target + path, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    let body = Buffer.from(await upstream.arrayBuffer());
    if (path.includes('/sync/push') && this.dropPushResponses > 0) {
      this.dropPushResponses--;
      return null; // merkez işledi, yanıt ajana ulaşmadı
    }
    if (this.rewriteHello && path.includes('/sync/hello') && upstream.ok) {
      const json = JSON.parse(body.toString()) as { data: Record<string, unknown> };
      json.data = this.rewriteHello(json.data);
      body = Buffer.from(JSON.stringify(json));
    }
    const out: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k)) out[k] = v;
    });
    return { status: upstream.status, headers: out, body };
  }
}
