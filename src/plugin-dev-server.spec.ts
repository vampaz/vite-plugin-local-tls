import { EventEmitter } from 'node:events';
import type { Plugin, ViteDevServer } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnedRouteInput } from './control-client.js';
import type {
  PluginControlClient,
  PluginInfrastructureRequest,
  PluginRuntimeDependencies,
} from './interfaces/plugin-runtime.js';
import type { ServiceState } from './interfaces/service-state.js';
import { createViteLocalTlsPlugin } from './plugin.js';
import { getStatePaths } from './state-paths.js';

interface MockHttpServer extends EventEmitter {
  listening: boolean;
  address: () => { address: string; family: string; port: number } | null;
}

interface RuntimeFixture {
  dependencies: PluginRuntimeDependencies;
  client: PluginControlClient;
  logs: string[];
  errors: Array<{ message: string; error?: unknown }>;
}

type SignalListener = (...arguments_: unknown[]) => void;

const httpServers = new Set<MockHttpServer>();
let originalSigintListeners: SignalListener[];
let originalSigtermListeners: SignalListener[];

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHttpServer(port: number, address = '127.0.0.1'): MockHttpServer {
  const server = new EventEmitter() as MockHttpServer;
  httpServers.add(server);
  server.listening = false;
  server.address = function getAddress() {
    return server.listening
      ? { address, family: address.includes(':') ? 'IPv6' : 'IPv4', port }
      : null;
  };
  return server;
}

function createServer(
  httpServer: MockHttpServer,
  overrides: Record<string, unknown> = {},
): ViteDevServer {
  return {
    httpServer,
    config: {
      root: '/tmp/app',
      server: { host: true, port: 5173 },
      preview: { host: true, port: 4173 },
    },
    ...overrides,
  } as unknown as ViteDevServer;
}

function configureServer(plugin: Plugin, server: ViteDevServer): void {
  if (typeof plugin.configureServer !== 'function') {
    throw new Error('Expected a configureServer hook.');
  }
  const hook = plugin.configureServer as (server: ViteDevServer) => void;
  hook(server);
}

function createRuntime(): RuntimeFixture {
  const logs: string[] = [];
  const errors: Array<{ message: string; error?: unknown }> = [];
  const claimedHostnames: string[] = [];
  const client: PluginControlClient = {
    ownerToken: 'owner-token-123456',
    claimedHostnames,
    connected: false,
    connect: vi.fn(async () => undefined),
    register: vi.fn(async (routes: OwnedRouteInput[]) => {
      const hostnames = routes.map(({ hostname }) => hostname);
      claimedHostnames.push(...hostnames);
      return hostnames;
    }),
    unregister: vi.fn(async (hostnames = [...claimedHostnames]) => hostnames),
    heartbeat: vi.fn(async (hostnames = [...claimedHostnames]) => hostnames),
    close: vi.fn(async () => undefined),
  };
  const dependencies: PluginRuntimeDependencies = {
    platform: 'darwin',
    logger: {
      info(message): void {
        logs.push(message);
      },
      warn(message): void {
        logs.push(message);
      },
      error(message, error): void {
        errors.push({ message, error });
      },
    },
    ensureInfrastructure: vi.fn(
      async ({ namespace, paths }: PluginInfrastructureRequest): Promise<ServiceState> => ({
        version: 1,
        pid: process.pid,
        namespace,
        socketPath: paths.socketPath,
        startedAt: new Date().toISOString(),
        protocolVersion: 1,
        port: 443,
        caFingerprint: 'fingerprint',
      }),
    ),
    createControlClient: vi.fn(() => client),
  };
  return { dependencies, client, logs, errors };
}

let runtime: RuntimeFixture;

beforeEach(() => {
  runtime = createRuntime();
  originalSigintListeners = process.listeners('SIGINT') as SignalListener[];
  originalSigtermListeners = process.listeners('SIGTERM') as SignalListener[];
});

afterEach(async () => {
  for (const server of httpServers) {
    server.emit('close');
  }
  httpServers.clear();
  await flushPromises();
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  for (const listener of originalSigintListeners) {
    process.on('SIGINT', listener);
  }
  for (const listener of originalSigtermListeners) {
    process.on('SIGTERM', listener);
  }
});

describe('Vite dev-server registration', () => {
  it('waits for listening and registers the actual auto-selected port', async () => {
    const httpServer = createHttpServer(4321);
    const server = createServer(httpServer);
    const plugin = createViteLocalTlsPlugin({ domain: 'app.localhost' }, runtime.dependencies);

    configureServer(plugin, server);
    expect(runtime.dependencies.ensureInfrastructure).not.toHaveBeenCalled();
    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    expect(runtime.client.register).toHaveBeenCalledWith([
      {
        hostname: 'app.localhost',
        upstreamHost: '127.0.0.1',
        upstreamPort: 4321,
      },
    ]);
    expect(runtime.logs).toContain('Local TLS upstream: http://127.0.0.1:4321');
    expect(runtime.logs).toContain('Local TLS URL: https://app.localhost');
  });

  it('prefers Vite resolved local URLs and forwards every route option', async () => {
    const httpServer = createHttpServer(5173);
    const server = createServer(httpServer, {
      resolvedUrls: { local: ['http://dev.example.test:3999'], network: [] },
    });
    const plugin = createViteLocalTlsPlugin(
      {
        domain: ['app.localhost', 'api.localhost'],
        cors: 'https://client.localhost',
        internalTls: true,
        upstreamHostHeader: 'localhost:3999',
        controlSocket: '/tmp/team-control.sock',
        serviceNamespace: 'team',
      },
      runtime.dependencies,
    );

    configureServer(plugin, server);
    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    expect(runtime.dependencies.ensureInfrastructure).toHaveBeenCalledWith({
      namespace: 'team',
      paths: expect.objectContaining({ socketPath: '/tmp/team-control.sock' }),
      controlSocket: '/tmp/team-control.sock',
    });
    expect(runtime.dependencies.createControlClient).toHaveBeenCalledWith(
      expect.objectContaining({ socketPath: '/tmp/team-control.sock' }),
    );
    expect(runtime.client.register).toHaveBeenCalledWith([
      {
        hostname: 'app.localhost',
        upstreamHost: 'dev.example.test',
        upstreamPort: 3999,
        cors: 'https://client.localhost',
        internalTls: true,
        upstreamHostHeader: 'localhost:3999',
      },
      {
        hostname: 'api.localhost',
        upstreamHost: 'dev.example.test',
        upstreamPort: 3999,
        cors: 'https://client.localhost',
        internalTls: true,
        upstreamHostHeader: 'localhost:3999',
      },
    ]);
  });

  it('uses one canonical port-443 infrastructure for ordinary plugin instances', async () => {
    const canonicalRuntime = createRuntime();
    canonicalRuntime.dependencies.infrastructureMode = 'canonical';
    const httpServer = createHttpServer(5174);
    const server = createServer(httpServer);
    const plugin = createViteLocalTlsPlugin(
      {
        domain: 'canonical.localhost',
        serviceNamespace: 'old-project-namespace',
        controlSocket: '/tmp/old-project-control.sock',
      },
      canonicalRuntime.dependencies,
    );

    configureServer(plugin, server);
    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    expect(canonicalRuntime.dependencies.ensureInfrastructure).toHaveBeenCalledWith({
      namespace: 'default',
      paths: getStatePaths('default'),
    });
    expect(canonicalRuntime.dependencies.createControlClient).toHaveBeenCalledWith(
      expect.objectContaining({ socketPath: getStatePaths('default').socketPath }),
    );
    expect(canonicalRuntime.logs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('serviceNamespace'),
        expect.stringContaining('controlSocket'),
      ]),
    );
  });

  it('connects to an active legacy service selected without route interruption', async () => {
    const legacyPaths = getStatePaths('legacy-winner');
    vi.mocked(runtime.dependencies.ensureInfrastructure).mockResolvedValueOnce({
      state: {
        version: 1,
        pid: 321,
        namespace: 'legacy-winner',
        socketPath: legacyPaths.socketPath,
        startedAt: new Date().toISOString(),
        protocolVersion: 1,
        port: 443,
        caFingerprint: 'legacy-fingerprint',
      },
      namespace: 'legacy-winner',
      paths: legacyPaths,
      adoptedLegacy: true,
      invalidInstallations: [],
    });
    const httpServer = createHttpServer(5175);
    const server = createServer(httpServer);
    const plugin = createViteLocalTlsPlugin({ domain: 'adopted.localhost' }, runtime.dependencies);

    configureServer(plugin, server);
    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    expect(runtime.dependencies.createControlClient).toHaveBeenCalledWith(
      expect.objectContaining({ socketPath: legacyPaths.socketPath }),
    );
  });

  it.each([
    ['0.0.0.0', '127.0.0.1'],
    ['::', '::1'],
  ])('maps wildcard listener %s to reachable loopback %s', async (address, expectedHost) => {
    const httpServer = createHttpServer(4010, address);
    const server = createServer(httpServer);
    const plugin = createViteLocalTlsPlugin({ domain: 'wildcard.localhost' }, runtime.dependencies);

    configureServer(plugin, server);
    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    expect(runtime.client.register).toHaveBeenCalledWith([
      expect.objectContaining({ upstreamHost: expectedHost, upstreamPort: 4010 }),
    ]);
  });

  it('closes the owning control lease when Vite closes', async () => {
    const httpServer = createHttpServer(4011);
    const server = createServer(httpServer);
    const plugin = createViteLocalTlsPlugin({ domain: 'close.localhost' }, runtime.dependencies);

    configureServer(plugin, server);
    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();
    httpServer.emit('close');
    await flushPromises();

    expect(runtime.client.close).toHaveBeenCalledOnce();
  });

  it('rolls back its own lease when registration fails after connection', async () => {
    const httpServer = createHttpServer(4012);
    const server = createServer(httpServer);
    vi.mocked(runtime.client.register).mockRejectedValueOnce(new Error('registration failed'));
    const plugin = createViteLocalTlsPlugin(
      { domain: ['one.localhost', 'two.localhost'] },
      runtime.dependencies,
    );

    configureServer(plugin, server);
    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    expect(runtime.client.close).toHaveBeenCalledOnce();
    expect(runtime.errors).toEqual([
      {
        message: 'Failed to register local TLS routes for one.localhost, two.localhost.',
        error: expect.any(Error),
      },
    ]);
  });

  it('fails before infrastructure startup with actionable domain diagnostics', () => {
    const httpServer = createHttpServer(4013);
    const plugin = createViteLocalTlsPlugin({ domain: [' ', ''] }, runtime.dependencies);

    configureServer(plugin, createServer(httpServer));

    expect(runtime.dependencies.ensureInfrastructure).not.toHaveBeenCalled();
    expect(runtime.errors[0]?.message).toContain('`domain` is empty after trimming');
  });
});
