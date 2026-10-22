import { execFileSync, spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { Stack, waitFor } from './stack.js';

/**
 * Docker imajı (önce: docker build -t stocktrack-sync:test .). İmaj yoksa
 * atlanır. Konteyner ana makinenin ağında, düzenekteki sunuculara bağlanır.
 */
const IMAGE = process.env.STSYNC_DOCKER_IMAGE ?? 'stocktrack-sync:test';
const NAME = 'stsync-docker-test';
const hasImage = spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' });

describe.skipIf(!hasImage)('Docker imajı', () => {
  let s: Stack | undefined;

  afterAll(async () => {
    spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
    await s?.stop();
  });

  it('konteynerdeki ajan yükler, gönderir, sağlık ucu yanıt verir, SIGTERM ile temiz kapanır', async () => {
    s = await Stack.start('docker');
    spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
    const env = s.agentEnv({ STATUS_PORT: '3914', LOG_DIR: '/app/logs' });
    const flags = ['UPSTREAM_URL', 'REPLICA_TOKEN', 'LOCAL_API_URL', 'REPLICA_DB_URL', 'SYNC_INTERVAL_SECONDS', 'SYNC_MAX_BACKOFF_SECONDS', 'STATUS_PORT', 'LOG_DIR'].flatMap(
      (k) => ['-e', `${k}=${env[k]}`],
    );
    docker('run', '-d', '--name', NAME, '--network', 'host', ...flags, IMAGE);

    await s.waitLoaded();
    const lt = await s.localLogin();
    const c = await s.L('POST', '/customers', { token: lt, shop: s.shop, body: { name: `Konteyner ${s.tag}` } });
    await s.assertConverged();
    expect((await s.pdb.query(`SELECT 1 FROM customers WHERE id = $1`, [c.data.id])).rowCount).toBe(1);

    const health = await waitFor(
      async () => JSON.parse(docker('exec', NAME, 'wget', '-qO-', 'http://127.0.0.1:3914/health')) as { ok: boolean },
      { what: 'sağlık ucu' },
    );
    expect(health.ok).toBe(true);
    expect(docker('exec', NAME, 'id', '-un').trim(), 'root olmayan kullanıcı').toBe('node');

    docker('stop', '-t', '40', NAME);
    expect(docker('inspect', '-f', '{{.State.ExitCode}}', NAME).trim()).toBe('0');
    const logs = docker('logs', NAME);
    expect(logs).toMatch(/Ajan durdu\./);
    expect(logs).not.toContain(s.replicaToken);
    expect((await s.state()).writes_paused_until).toBeNull();
  });
});
