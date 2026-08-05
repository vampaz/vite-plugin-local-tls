import { EventEmitter } from 'node:events';
import type { Plugin, PreviewServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OwnedRouteInput } from './control-client.js';
import type {
  PluginControlClient,
  PluginInfrastructureRequest,
  PluginRuntimeDependencies,
} from './interfaces/plugin-runtime.js';
import type { ServiceState } from './interfaces/service-state.js';
import { createViteLocalTlsPlugin } from './plugin.js';

interface MockHttpServer extends EventEmitter {
  listening: boolean;
  address: () => { address: string; family: string; port: number } | null;
}

const servers = new Set<MockHttpServer>();

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createPreviewServer(port: number, resolvedUrl?: string): PreviewServer {
  const httpServer = new EventEmitter() as MockHttpServer;
  servers.add(httpServer);
  httpServer.listening = false;
  httpServer.address = function address() {
    return httpServer.listening ? { address: '::', family: 'IPv6', port } : null;
  };
  return {
    httpServer,
    resolvedUrls: resolvedUrl ? { local: [resolvedUrl], network: [] } : null,
    config: {
      root: '/tmp/preview',
      server: { host: true, port: 5173 },
      preview: { host: '::', port: 4173 },
    },
  } as unknown as PreviewServer;
}

function configurePreviewServer(plugin: Plugin, server: PreviewServer): void {
  if (typeof plugin.configurePreviewServer !== 'function') {
    throw new Error('Expected a configurePreviewServer hook.');
  }
  const hook = plugin.configurePreviewServer as (server: PreviewServer) => void;
  hook(server);
}

function createRuntime(): {
  dependencies: PluginRuntimeDependencies;
  client: PluginControlClient;
  logs: string[];
} {
  const logs: string[] = [];
  const client: PluginControlClient = {
    ownerToken: 'owner-token-123456',
    connected: true,
    claimedHostnames: [],
    connect: vi.fn(async () => undefined),
    register: vi.fn(async (routes: OwnedRouteInput[]) => routes.map(({ hostname }) => hostname)),
    unregister: vi.fn(async () => []),
    heartbeat: vi.fn(async () => []),
    close: vi.fn(async () => undefined),
  };
  return {
    client,
    logs,
    dependencies: {
      platform: 'darwin',
      logger: {
        info(message): void {
          logs.push(message);
        },
        warn(): void {},
        error(): void {},
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
    },
  };
}

afterEach(async () => {
  for (const server of servers) {
    server.emit('close');
  }
  servers.clear();
  await flushPromises();
});

describe('Vite preview integration', () => {
  it('registers the actual preview target and releases only its lease on close', async () => {
    const runtime = createRuntime();
    const preview = createPreviewServer(4555);
    const plugin = createViteLocalTlsPlugin(
      {
        domain: ['preview.localhost', 'assets.localhost'],
        cors: '*',
        upstreamHostHeader: 'localhost',
      },
      runtime.dependencies,
    );

    configurePreviewServer(plugin, preview);
    (preview.httpServer as MockHttpServer).listening = true;
    preview.httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    expect(runtime.client.register).toHaveBeenCalledWith([
      {
        hostname: 'preview.localhost',
        upstreamHost: '::1',
        upstreamPort: 4555,
        cors: '*',
        upstreamHostHeader: 'localhost',
      },
      {
        hostname: 'assets.localhost',
        upstreamHost: '::1',
        upstreamPort: 4555,
        cors: '*',
        upstreamHostHeader: 'localhost',
      },
    ]);
    expect(runtime.logs).toContain('Local TLS upstream: http://[::1]:4555');
    expect(runtime.logs).toContain('Local TLS URL: https://preview.localhost');

    preview.httpServer.emit('close');
    await flushPromises();
    expect(runtime.client.close).toHaveBeenCalledOnce();
  });

  it('prefers the preview resolved URL over configured fallback values', async () => {
    const runtime = createRuntime();
    const preview = createPreviewServer(4556, 'http://localhost:4666');
    const plugin = createViteLocalTlsPlugin(
      { domain: 'resolved-preview.localhost' },
      runtime.dependencies,
    );

    configurePreviewServer(plugin, preview);
    (preview.httpServer as MockHttpServer).listening = true;
    preview.httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    expect(runtime.client.register).toHaveBeenCalledWith([
      expect.objectContaining({ upstreamHost: '127.0.0.1', upstreamPort: 4666 }),
    ]);
  });
});
