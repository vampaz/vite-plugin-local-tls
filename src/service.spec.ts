import { access, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControlClient } from './control-client.js';
import { LocalTlsDaemon } from './daemon.js';
import { LocalTlsService } from './service.js';
import { ensureStatePaths, getStatePaths } from './state-paths.js';

let temporaryDirectory: string;
let namespace: string;
let daemon: LocalTlsDaemon | null;
let unrelatedServer: Server | null;
const clients: ControlClient[] = [];
const unrelatedSockets = new Set<Socket>();

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-service-'));
  namespace = path.basename(temporaryDirectory).slice(-6);
  daemon = null;
  unrelatedServer = null;
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await daemon?.stop();
  for (const socket of unrelatedSockets) {
    socket.destroy();
  }
  unrelatedSockets.clear();
  if (unrelatedServer?.listening) {
    await closeServer(unrelatedServer);
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('LocalTlsService', () => {
  it('lets only one simultaneous caller start the daemon without losing registrations', async () => {
    const paths = getStatePaths(namespace, process.platform, { HOME: temporaryDirectory });
    let starts = 0;
    async function startDaemon(): Promise<Awaited<ReturnType<LocalTlsDaemon['start']>>> {
      starts += 1;
      daemon = new LocalTlsDaemon({ paths, opensslPath: 'openssl', namespace, port: 0 });
      return daemon.start();
    }
    const services = Array.from(
      { length: 6 },
      () =>
        new LocalTlsService({
          paths,
          opensslPath: 'openssl',
          namespace,
          port: 0,
          startDaemon,
        }),
    );

    const states = await Promise.all(services.map((service) => service.ensureRunning()));
    for (let index = 0; index < services.length; index += 1) {
      const client = new ControlClient({ socketPath: paths.socketPath });
      clients.push(client);
      await client.connect();
      await client.register([
        {
          hostname: `app-${index}.localhost`,
          upstreamHost: '127.0.0.1',
          upstreamPort: 5000 + index,
        },
      ]);
    }

    expect(starts).toBe(1);
    expect(new Set(states.map((state) => state.startedAt)).size).toBe(1);
    expect(daemon?.registry.size).toBe(6);
  });

  it('waits for state metadata while a locked daemon startup becomes healthy', async () => {
    const paths = getStatePaths(namespace, process.platform, { HOME: temporaryDirectory });
    daemon = new LocalTlsDaemon({ paths, opensslPath: 'openssl', namespace, port: 0 });
    const expected = await daemon.start();
    await unlink(paths.stateFile);
    await writeFile(
      paths.lockPath,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
    const service = new LocalTlsService({
      paths,
      opensslPath: 'openssl',
      namespace,
      startupTimeoutMs: 1000,
      retryDelayMs: 10,
    });

    const outcome = service.ensureRunning().then(
      (state) => ({ state }),
      (error: unknown) => ({ error }),
    );
    await delay(100);
    await writeFile(paths.stateFile, `${JSON.stringify(expected)}\n`);
    await unlink(paths.lockPath);

    await expect(outcome).resolves.toEqual({ state: expected });
  });

  it('replaces stale metadata and a lock owned by a dead process', async () => {
    const paths = getStatePaths(namespace, process.platform, { HOME: temporaryDirectory });
    await ensureStatePaths(paths);
    const deadPid = 2_147_483_647;
    await writeFile(
      paths.stateFile,
      `${JSON.stringify({
        version: 1,
        pid: deadPid,
        namespace,
        socketPath: paths.socketPath,
        startedAt: new Date(0).toISOString(),
        protocolVersion: 1,
        port: 443,
        caFingerprint: 'stale',
      })}\n`,
    );
    await writeFile(
      paths.lockPath,
      `${JSON.stringify({ pid: deadPid, startedAt: new Date(0).toISOString() })}\n`,
    );
    const service = new LocalTlsService({
      paths,
      opensslPath: 'openssl',
      namespace,
      port: 0,
      startupTimeoutMs: 1000,
      retryDelayMs: 10,
    });

    const state = await service.ensureRunning();
    daemon = null;

    expect(state.pid).toBe(process.pid);
    await expect(access(paths.lockPath)).rejects.toThrow();
    await service.stopStartedDaemon();
  });

  it('clears a pre-reboot lock even when its PID has been reused', async () => {
    const paths = getStatePaths(namespace, process.platform, { HOME: temporaryDirectory });
    await ensureStatePaths(paths);
    await writeFile(
      paths.lockPath,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date(0).toISOString() })}\n`,
    );
    const service = new LocalTlsService({
      paths,
      opensslPath: 'openssl',
      namespace,
      port: 0,
      startupTimeoutMs: 1000,
      retryDelayMs: 10,
    });

    const state = await service.ensureRunning();
    daemon = null;

    expect(state.pid).toBe(process.pid);
    await expect(access(paths.lockPath)).rejects.toThrow();
    await service.stopStartedDaemon();
  });

  it('replaces pre-reboot metadata even when its PID has been reused', async () => {
    const paths = getStatePaths(namespace, process.platform, { HOME: temporaryDirectory });
    await ensureStatePaths(paths);
    await writeFile(
      paths.stateFile,
      `${JSON.stringify({
        version: 1,
        pid: process.pid,
        namespace,
        socketPath: paths.socketPath,
        startedAt: new Date(0).toISOString(),
        protocolVersion: 1,
        port: 443,
        caFingerprint: 'pre-reboot',
      })}\n`,
    );
    const service = new LocalTlsService({
      paths,
      opensslPath: 'openssl',
      namespace,
      port: 0,
      startupTimeoutMs: 1000,
      retryDelayMs: 10,
    });

    const state = await service.ensureRunning();
    daemon = null;

    expect(state.pid).toBe(process.pid);
    expect(state.startedAt).not.toBe(new Date(0).toISOString());
    await service.stopStartedDaemon();
  });

  it('returns an already healthy daemon without starting another one', async () => {
    const paths = getStatePaths(namespace, process.platform, { HOME: temporaryDirectory });
    daemon = new LocalTlsDaemon({ paths, opensslPath: 'openssl', namespace, port: 0 });
    const expected = await daemon.start();
    let starts = 0;
    const service = new LocalTlsService({
      paths,
      opensslPath: 'openssl',
      namespace,
      startDaemon: async () => {
        starts += 1;
        return expected;
      },
    });

    await expect(service.ensureRunning()).resolves.toEqual(expected);
    expect(starts).toBe(0);
  });

  it('refuses to replace an unrelated active control-socket listener', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const paths = getStatePaths(namespace, process.platform, { HOME: temporaryDirectory });
    await ensureStatePaths(paths);
    unrelatedServer = createServer((socket) => {
      unrelatedSockets.add(socket);
      socket.once('close', () => unrelatedSockets.delete(socket));
      socket.end('not-the-control-protocol\n');
    });
    await new Promise<void>((resolve, reject) => {
      unrelatedServer?.once('error', reject);
      unrelatedServer?.listen(paths.socketPath, resolve);
    });
    let starts = 0;
    const service = new LocalTlsService({
      paths,
      opensslPath: 'openssl',
      namespace,
      probeTimeoutMs: 100,
      startDaemon: async () => {
        starts += 1;
        throw new Error('must not start');
      },
    });

    await expect(service.ensureRunning()).rejects.toMatchObject({ code: 'UNRELATED_LISTENER' });
    expect(starts).toBe(0);
    await expect(access(paths.socketPath)).resolves.toBeUndefined();
  });
});
