import { EventEmitter } from 'node:events';
import type { Plugin, ViteDevServer } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnedRouteInput } from './control-client.js';
import type { ControlClientOptions } from './interfaces/control-client-options.js';
import type {
  PluginControlClient,
  PluginRuntimeDependencies,
} from './interfaces/plugin-runtime.js';
import { createViteLocalTlsPlugin } from './plugin.js';

interface MockHttpServer extends EventEmitter {
  listening: boolean;
  address: () => { address: string; family: string; port: number };
}

interface MockClient extends PluginControlClient {
  options: ControlClientOptions;
}

const servers = new Set<MockHttpServer>();
type SignalListener = (...arguments_: unknown[]) => void;
let originalSigintListeners: SignalListener[];
let originalSigtermListeners: SignalListener[];

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createClient(
  options: ControlClientOptions,
  connect: () => Promise<void> = async () => undefined,
): MockClient {
  const claimedHostnames: string[] = [];
  return {
    options,
    ownerToken: options.ownerToken ?? 'stable-owner-token',
    connected: true,
    claimedHostnames,
    connect: vi.fn(connect),
    register: vi.fn(async (routes: OwnedRouteInput[]) => {
      const hostnames = routes.map(({ hostname }) => hostname);
      claimedHostnames.push(...hostnames);
      return hostnames;
    }),
    unregister: vi.fn(async () => []),
    heartbeat: vi.fn(async (hostnames = claimedHostnames) => hostnames),
    close: vi.fn(async () => undefined),
  };
}

function configureServer(plugin: Plugin, server: ViteDevServer): void {
  if (typeof plugin.configureServer !== 'function') {
    throw new Error('Expected a configureServer hook.');
  }
  const hook = plugin.configureServer as (server: ViteDevServer) => void;
  hook(server);
}

function createServer(port: number): { server: ViteDevServer; httpServer: MockHttpServer } {
  const httpServer = new EventEmitter() as MockHttpServer;
  servers.add(httpServer);
  httpServer.listening = false;
  httpServer.address = function address() {
    return { address: '127.0.0.1', family: 'IPv4', port };
  };
  return {
    httpServer,
    server: {
      httpServer,
      config: {
        root: '/tmp/reconnect',
        server: { host: true, port: 5173 },
        preview: { host: true, port: 4173 },
      },
    } as unknown as ViteDevServer,
  };
}

function createRuntime(clientFactory: (options: ControlClientOptions) => MockClient): {
  dependencies: PluginRuntimeDependencies;
  logs: string[];
  errors: string[];
  ensureInfrastructure: ReturnType<typeof vi.fn<PluginRuntimeDependencies['ensureInfrastructure']>>;
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const ensureInfrastructure = vi.fn<PluginRuntimeDependencies['ensureInfrastructure']>(
    async ({ namespace, paths }) => ({
      version: 1,
      pid: process.pid,
      namespace,
      socketPath: paths.socketPath,
      startedAt: new Date().toISOString(),
      protocolVersion: 1,
      port: 443,
      caFingerprint: 'fingerprint',
    }),
  );
  return {
    logs,
    errors,
    ensureInfrastructure,
    dependencies: {
      platform: 'darwin',
      ensureInfrastructure,
      createControlClient: clientFactory,
      logger: {
        info(message): void {
          logs.push(message);
        },
        warn(): void {},
        error(message): void {
          errors.push(message);
        },
      },
    },
  };
}

async function startPlugin(
  dependencies: PluginRuntimeDependencies,
  domains: string[],
): Promise<MockHttpServer> {
  const { server, httpServer } = createServer(4301);
  configureServer(
    createViteLocalTlsPlugin(
      { domain: domains, controlSocket: '/tmp/reconnect.sock' },
      dependencies,
    ),
    server,
  );
  httpServer.listening = true;
  httpServer.emit('listening');
  await flushPromises();
  await flushPromises();
  return httpServer;
}

beforeEach(() => {
  originalSigintListeners = process.listeners('SIGINT') as SignalListener[];
  originalSigtermListeners = process.listeners('SIGTERM') as SignalListener[];
});

afterEach(async () => {
  for (const server of servers) {
    server.emit('close');
  }
  servers.clear();
  await flushPromises();
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  for (const listener of originalSigintListeners) {
    process.on('SIGINT', listener);
  }
  for (const listener of originalSigtermListeners) {
    process.on('SIGTERM', listener);
  }
  vi.restoreAllMocks();
});

describe('plugin daemon recovery', () => {
  it('restarts infrastructure and re-registers the same owner claims after disconnect', async () => {
    const clients: MockClient[] = [];
    const runtime = createRuntime((options) => {
      const client = createClient(options);
      clients.push(client);
      return client;
    });
    await startPlugin(runtime.dependencies, ['app.localhost', 'api.localhost']);
    await vi.waitFor(() => expect(clients).toHaveLength(1));

    clients[0]?.options.onDisconnect?.(new Error('daemon stopped'));
    await vi.waitFor(() => expect(clients).toHaveLength(2));
    await vi.waitFor(() => expect(clients[1]?.register).toHaveBeenCalledOnce());

    expect(clients[1]?.ownerToken).toBe(clients[0]?.ownerToken);
    expect(clients[1]?.register).toHaveBeenCalledWith([
      { hostname: 'app.localhost', upstreamHost: '127.0.0.1', upstreamPort: 4301 },
      { hostname: 'api.localhost', upstreamHost: '127.0.0.1', upstreamPort: 4301 },
    ]);
    expect(runtime.ensureInfrastructure).toHaveBeenCalledTimes(2);
    expect(runtime.logs).toContain('Recovered local TLS routes for app.localhost, api.localhost.');
  });

  it('does not reclaim a hostname that a newer Vite server took before recovery', async () => {
    const clients: MockClient[] = [];
    const runtime = createRuntime((options) => {
      const client = createClient(options);
      clients.push(client);
      return client;
    });
    await startPlugin(runtime.dependencies, ['app.localhost', 'api.localhost']);
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    clients[0]?.options.onRouteLost?.({
      hostname: 'app.localhost',
      ownerToken: clients[0]?.ownerToken ?? '',
      replacementOwnerToken: 'new-owner-token',
    });

    clients[0]?.options.onDisconnect?.(new Error('daemon stopped'));
    await vi.waitFor(() => expect(clients).toHaveLength(2));
    await vi.waitFor(() => expect(clients[1]?.register).toHaveBeenCalledOnce());

    expect(clients[1]?.register).toHaveBeenCalledWith([
      { hostname: 'api.localhost', upstreamHost: '127.0.0.1', upstreamPort: 4301 },
    ]);
  });

  it('does not restart infrastructure after every hostname was taken over', async () => {
    const clients: MockClient[] = [];
    const runtime = createRuntime((options) => {
      const client = createClient(options);
      clients.push(client);
      return client;
    });
    await startPlugin(runtime.dependencies, ['app.localhost']);
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    clients[0]?.options.onRouteLost?.({
      hostname: 'app.localhost',
      ownerToken: clients[0]?.ownerToken ?? '',
      replacementOwnerToken: 'new-owner-token',
    });

    clients[0]?.options.onDisconnect?.(new Error('daemon stopped'));
    await flushPromises();
    await flushPromises();

    expect(clients).toHaveLength(1);
    expect(runtime.ensureInfrastructure).toHaveBeenCalledOnce();
  });

  it('does not reclaim a hostname taken over while infrastructure is recovering', async () => {
    const clients: MockClient[] = [];
    const runtime = createRuntime((options) => {
      const client = createClient(options);
      clients.push(client);
      return client;
    });
    await startPlugin(runtime.dependencies, ['app.localhost']);
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    let finishRecovery: (() => void) | undefined;
    runtime.ensureInfrastructure.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRecovery = function resolveRecovery() {
            resolve({
              version: 1,
              pid: process.pid,
              namespace: 'default',
              socketPath: '/tmp/reconnect.sock',
              startedAt: new Date().toISOString(),
              protocolVersion: 1,
              port: 443,
              caFingerprint: 'fingerprint',
            });
          };
        }),
    );

    clients[0]?.options.onDisconnect?.(new Error('daemon stopped'));
    await vi.waitFor(() => expect(runtime.ensureInfrastructure).toHaveBeenCalledTimes(2));
    clients[0]?.options.onRouteLost?.({
      hostname: 'app.localhost',
      ownerToken: clients[0]?.ownerToken ?? '',
      replacementOwnerToken: 'new-owner-token',
    });
    finishRecovery?.();
    await flushPromises();
    await flushPromises();

    expect(clients).toHaveLength(1);
  });

  it('reports a prominent HTTPS and HMR failure after bounded recovery attempts', async () => {
    const clients: MockClient[] = [];
    const runtime = createRuntime((options) => {
      const client =
        clients.length === 0
          ? createClient(options)
          : createClient(options, async () => {
              throw new Error('still unavailable');
            });
      clients.push(client);
      return client;
    });
    await startPlugin(runtime.dependencies, ['failed.localhost']);
    await vi.waitFor(() => expect(clients).toHaveLength(1));

    clients[0]?.options.onDisconnect?.(new Error('daemon stopped'));
    await vi.waitFor(
      () =>
        expect(runtime.errors).toContain(
          'Local TLS route recovery failed for failed.localhost; HTTPS and HMR over WSS are unavailable while the Vite server remains running.',
        ),
      { timeout: 1500 },
    );

    expect(clients).toHaveLength(4);
    expect(runtime.ensureInfrastructure).toHaveBeenCalledTimes(4);
  });
});
