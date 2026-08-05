import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlClient } from './control-client.js';
import { ControlServer } from './control-server.js';
import type {
  PluginControlClient,
  PluginInfrastructureRequest,
  PluginRuntimeDependencies,
} from './interfaces/plugin-runtime.js';
import type { ServiceState } from './interfaces/service-state.js';
import { createViteLocalTlsPlugin, PLUGIN_HEARTBEAT_INTERVAL_MS } from './plugin.js';
import { RouteRegistry } from './route-registry.js';

interface MockHttpServer extends EventEmitter {
  listening: boolean;
  address: () => { address: string; family: string; port: number };
}

interface RuntimeFixture {
  dependencies: PluginRuntimeDependencies;
  errors: string[];
}

type SignalListener = (...arguments_: unknown[]) => void;

let temporaryDirectory: string;
let controlServer: ControlServer | null;
let registry: RouteRegistry;
let socketPath: string;
let originalSigintListeners: SignalListener[];
let originalSigtermListeners: SignalListener[];
const httpServers = new Set<MockHttpServer>();
const clients = new Set<PluginControlClient>();

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHttpServer(port: number): MockHttpServer {
  const server = new EventEmitter() as MockHttpServer;
  server.listening = false;
  server.address = function address() {
    return { address: '127.0.0.1', family: 'IPv4', port };
  };
  httpServers.add(server);
  return server;
}

function createServer(httpServer: MockHttpServer): ViteDevServer {
  return {
    httpServer,
    config: {
      root: temporaryDirectory,
      server: { host: true, port: 5173 },
      preview: { host: true, port: 4173 },
    },
  } as unknown as ViteDevServer;
}

function configureServer(plugin: Plugin, server: ViteDevServer): void {
  if (typeof plugin.configureServer !== 'function') {
    throw new Error('Expected a configureServer hook.');
  }
  const hook = plugin.configureServer as (server: ViteDevServer) => void;
  hook(server);
}

function createRuntime(
  clientFactory?: PluginRuntimeDependencies['createControlClient'],
): RuntimeFixture {
  const errors: string[] = [];
  const dependencies: PluginRuntimeDependencies = {
    platform: 'darwin',
    logger: {
      info(): void {},
      warn(): void {},
      error(message): void {
        errors.push(message);
      },
    },
    async ensureInfrastructure(request: PluginInfrastructureRequest): Promise<ServiceState> {
      return {
        version: 1,
        pid: process.pid,
        namespace: request.namespace,
        socketPath: request.paths.socketPath,
        startedAt: new Date().toISOString(),
        protocolVersion: 1,
        port: 443,
        caFingerprint: 'fingerprint',
      };
    },
    createControlClient:
      clientFactory ??
      ((options) => {
        const client = new ControlClient(options);
        clients.add(client);
        return client;
      }),
  };
  return { dependencies, errors };
}

async function startPlugin(
  runtime: RuntimeFixture,
  domains: string[],
  port: number,
): Promise<MockHttpServer> {
  const httpServer = createHttpServer(port);
  const plugin = createViteLocalTlsPlugin(
    { domain: domains, controlSocket: socketPath },
    runtime.dependencies,
  );
  configureServer(plugin, createServer(httpServer));
  httpServer.listening = true;
  httpServer.emit('listening');
  await flushPromises();
  await flushPromises();
  return httpServer;
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-ownership-'));
  socketPath = path.join(temporaryDirectory, 'control.sock');
  registry = new RouteRegistry();
  controlServer = new ControlServer({ socketPath, registry });
  await controlServer.start();
  originalSigintListeners = process.listeners('SIGINT') as SignalListener[];
  originalSigtermListeners = process.listeners('SIGTERM') as SignalListener[];
});

afterEach(async () => {
  vi.useRealTimers();
  for (const server of httpServers) {
    server.emit('close');
  }
  httpServers.clear();
  await flushPromises();
  for (const client of clients) {
    await client.close();
  }
  clients.clear();
  await controlServer?.stop();
  controlServer = null;
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  for (const listener of originalSigintListeners) {
    process.on('SIGINT', listener);
  }
  for (const listener of originalSigtermListeners) {
    process.on('SIGTERM', listener);
  }
  vi.restoreAllMocks();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('plugin route ownership', () => {
  it('preserves sibling routes and prevents old cleanup from undoing latest-started takeover', async () => {
    const oldRuntime = createRuntime();
    const newRuntime = createRuntime();
    const oldServer = await startPlugin(oldRuntime, ['app.localhost', 'api.localhost'], 4101);
    await vi.waitFor(() => expect(registry.size).toBe(2));
    expect(registry.get('app.localhost')?.upstreamPort).toBe(4101);
    expect(registry.get('api.localhost')?.upstreamPort).toBe(4101);

    const newServer = await startPlugin(newRuntime, ['app.localhost'], 4102);
    await vi.waitFor(() =>
      expect(oldRuntime.errors).toContain(
        'Lost local TLS route ownership for app.localhost; a newer Vite server now owns that hostname.',
      ),
    );
    expect(registry.get('app.localhost')?.upstreamPort).toBe(4102);
    expect(registry.get('api.localhost')?.upstreamPort).toBe(4101);

    oldServer.emit('close');
    await vi.waitFor(() => expect(registry.get('api.localhost')).toBeUndefined());
    expect(registry.get('app.localhost')?.upstreamPort).toBe(4102);

    newServer.emit('close');
    await vi.waitFor(() => expect(registry.get('app.localhost')).toBeUndefined());
  });

  it('retries transient cleanup failures before reporting success', async () => {
    const close = vi
      .fn<PluginControlClient['close']>()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockResolvedValueOnce(undefined);
    const client: PluginControlClient = {
      ownerToken: 'owner-token-123456',
      connected: true,
      claimedHostnames: ['retry.localhost'],
      connect: vi.fn(async () => undefined),
      register: vi.fn(async () => ['retry.localhost']),
      unregister: vi.fn(async () => ['retry.localhost']),
      heartbeat: vi.fn(async () => ['retry.localhost']),
      close,
    };
    const runtime = createRuntime(() => client);
    const server = await startPlugin(runtime, ['retry.localhost'], 4103);

    server.emit('close');
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(3), { timeout: 1000 });
    expect(runtime.errors).toEqual([]);
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('releases the route on %s before exiting with %i', async (signal, exitCode) => {
    const close = vi.fn(async () => undefined);
    const client: PluginControlClient = {
      ownerToken: 'owner-token-123456',
      connected: true,
      claimedHostnames: ['signal.localhost'],
      connect: vi.fn(async () => undefined),
      register: vi.fn(async () => ['signal.localhost']),
      unregister: vi.fn(async () => ['signal.localhost']),
      heartbeat: vi.fn(async () => ['signal.localhost']),
      close,
    };
    const runtime = createRuntime(() => client);
    await startPlugin(runtime, ['signal.localhost'], 4104);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    process.emit(signal);
    await flushPromises();

    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(exitCode);
  });

  it('reports route loss discovered by heartbeat without stopping the Vite server', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const client: PluginControlClient = {
      ownerToken: 'owner-token-123456',
      connected: true,
      claimedHostnames: ['heartbeat.localhost'],
      connect: vi.fn(async () => undefined),
      register: vi.fn(async () => ['heartbeat.localhost']),
      unregister: vi.fn(async () => []),
      heartbeat: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
    };
    const runtime = createRuntime(() => client);
    const server = await startPlugin(runtime, ['heartbeat.localhost'], 4105);

    await vi.advanceTimersByTimeAsync(PLUGIN_HEARTBEAT_INTERVAL_MS);

    expect(runtime.errors).toContain(
      'Lost local TLS route ownership for heartbeat.localhost; the Vite server is still running.',
    );
    expect(server.listening).toBe(true);
  });
});
