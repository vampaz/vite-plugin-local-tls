import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalTlsDaemon } from './daemon.js';
import type { StatePaths } from './interfaces/state-paths.js';
import { LocalTlsService } from './service.js';
import { ensureStatePaths, getStatePaths } from './state-paths.js';

interface MockDaemon {
  server: Server;
  stopRequests: () => number;
  close: () => Promise<void>;
}

let temporaryDirectory: string;
let namespace: string;
let daemon: LocalTlsDaemon | null;
let mockDaemon: MockDaemon | null;

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startMockDaemon(
  paths: StatePaths,
  namespace: string,
  protocolVersion: number,
  activeRoutes: number,
): Promise<MockDaemon> {
  const sockets = new Set<Socket>();
  let stopRequests = 0;
  let closing = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.once('close', () => sockets.delete(socket));
    socket.on('data', (chunk: string) => {
      const frame = chunk.slice(0, chunk.indexOf('\n'));
      const request = JSON.parse(frame) as Record<string, unknown>;
      if (request.type === 'negotiate') {
        socket.write(
          `${JSON.stringify({
            version: 0,
            type: 'negotiated',
            requestId: request.requestId,
            protocolVersion,
            activeRoutes,
          })}\n`,
        );
        return;
      }
      if (request.type === 'stop-if-idle') {
        stopRequests += 1;
        if (activeRoutes > 0) {
          socket.write(
            `${JSON.stringify({
              version: 0,
              type: 'error',
              requestId: request.requestId,
              code: 'ROUTES_ACTIVE',
              message: 'Routes are active.',
            })}\n`,
          );
          return;
        }
        socket.write(
          `${JSON.stringify({
            version: 0,
            type: 'stopping',
            requestId: request.requestId,
          })}\n`,
          () => {
            if (closing) {
              return;
            }
            closing = true;
            for (const activeSocket of sockets) {
              activeSocket.destroy();
            }
            void closeServer(server).then(async () => {
              await unlink(paths.stateFile).catch(() => undefined);
            });
          },
        );
      }
    });
  });
  await listen(server, paths.socketPath);
  await writeFile(
    paths.stateFile,
    `${JSON.stringify({
      version: 1,
      pid: process.pid,
      namespace,
      socketPath: paths.socketPath,
      startedAt: new Date().toISOString(),
      protocolVersion,
      port: 443,
      caFingerprint: 'mock',
    })}\n`,
  );
  return {
    server,
    stopRequests: () => stopRequests,
    async close(): Promise<void> {
      for (const socket of sockets) {
        socket.destroy();
      }
      if (server.listening) {
        await closeServer(server);
      }
    },
  };
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-version-'));
  namespace = path.basename(temporaryDirectory).slice(-6);
  daemon = null;
  mockDaemon = null;
});

afterEach(async () => {
  await daemon?.stop();
  await mockDaemon?.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('local TLS service version negotiation', () => {
  it('never interrupts an incompatible daemon with active routes', async () => {
    const paths = getStatePaths(namespace, process.platform, { HOME: temporaryDirectory });
    await ensureStatePaths(paths);
    mockDaemon = await startMockDaemon(paths, namespace, 2, 3);
    let starts = 0;
    const service = new LocalTlsService({
      paths,
      opensslPath: 'openssl',
      namespace,
      startDaemon: async () => {
        starts += 1;
        throw new Error('must not start');
      },
    });

    await expect(service.ensureRunning()).rejects.toMatchObject({
      code: 'INCOMPATIBLE_ACTIVE_DAEMON',
    });
    expect(starts).toBe(0);
    expect(mockDaemon.stopRequests()).toBe(0);
    expect(mockDaemon.server.listening).toBe(true);
  });

  it('replaces an incompatible daemon only after it confirms that it is idle', async () => {
    const paths = getStatePaths(namespace, process.platform, { HOME: temporaryDirectory });
    await ensureStatePaths(paths);
    mockDaemon = await startMockDaemon(paths, namespace, 2, 0);
    let starts = 0;
    async function startDaemon(): Promise<Awaited<ReturnType<LocalTlsDaemon['start']>>> {
      starts += 1;
      daemon = new LocalTlsDaemon({ paths, opensslPath: 'openssl', namespace, port: 0 });
      return daemon.start();
    }
    const service = new LocalTlsService({
      paths,
      opensslPath: 'openssl',
      namespace,
      port: 0,
      retryDelayMs: 10,
      startDaemon,
    });

    const state = await service.ensureRunning();

    expect(mockDaemon.stopRequests()).toBe(1);
    expect(starts).toBe(1);
    expect(state.protocolVersion).toBe(1);
  });
});
