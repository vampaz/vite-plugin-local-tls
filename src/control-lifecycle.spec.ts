import { fork, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlServer } from './control-server.js';
import { RouteRegistry } from './route-registry.js';

const fixturePath = fileURLToPath(
  new URL('../tests/fixtures/control-client-process.ts', import.meta.url),
);
let temporaryDirectory: string;
let socketPath: string;
let registry: RouteRegistry;
let server: ControlServer | null;
const children = new Set<ChildProcess>();

function spawnFixture(
  mode: 'client' | 'stale-socket',
  fixtureSocketPath: string,
  ownerToken = 'owner-token-00000001',
  hostnames: string[] = [],
): ChildProcess {
  const child = fork(
    fixturePath,
    [mode, fixtureSocketPath, ownerToken, JSON.stringify(hostnames)],
    {
      execArgv: ['--experimental-strip-types'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture did not become ready.')), 5000);
    child.on('message', (message) => {
      if ((message as { type?: string }).type === 'ready') {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Fixture exited before ready with code ${String(code)}.`));
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-lifecycle-'));
  socketPath = path.join(temporaryDirectory, 'control.sock');
  registry = new RouteRegistry();
  server = new ControlServer({ socketPath, registry });
  await server.start();
});

afterEach(async () => {
  for (const child of children) {
    child.kill('SIGKILL');
  }
  await Promise.all([...children].map(waitForExit));
  await server?.stop();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('control lifecycle', () => {
  it('removes a force-killed lease while preserving unrelated live registrations', async () => {
    const first = spawnFixture('client', socketPath, 'owner-token-00000001', ['first.localhost']);
    const second = spawnFixture('client', socketPath, 'owner-token-00000002', ['second.localhost']);
    await Promise.all([waitForReady(first), waitForReady(second)]);
    expect(registry.size).toBe(2);

    const firstExit = waitForExit(first);
    first.kill('SIGKILL');
    await firstExit;
    await vi.waitFor(() => expect(registry.get('first.localhost')).toBeUndefined());

    expect(registry.get('second.localhost')?.ownerToken).toBe('owner-token-00000002');
  });

  it('serializes concurrent claims without losing unrelated hostnames', async () => {
    const fixtures = Array.from({ length: 6 }, (_, index) =>
      spawnFixture('client', socketPath, `owner-token-0000000${index + 1}`, [
        `app-${index + 1}.localhost`,
      ]),
    );
    await Promise.all(fixtures.map(waitForReady));

    expect(
      registry
        .list()
        .map(({ hostname }) => hostname)
        .sort(),
    ).toEqual(Array.from({ length: 6 }, (_, index) => `app-${index + 1}.localhost`));
  });

  it('reclaims the Unix socket left by a force-killed process', async () => {
    await server?.stop();
    server = null;
    await mkdir(path.dirname(socketPath), { recursive: true });
    const staleProcess = spawnFixture('stale-socket', socketPath);
    await waitForReady(staleProcess);
    const staleExit = waitForExit(staleProcess);
    staleProcess.kill('SIGKILL');
    await staleExit;
    await expect(access(socketPath)).resolves.toBeUndefined();

    server = new ControlServer({ socketPath, registry });
    await expect(server.start()).resolves.toBeUndefined();
  });
});
