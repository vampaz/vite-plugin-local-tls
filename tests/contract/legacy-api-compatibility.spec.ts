import { EventEmitter } from 'node:events';
import type { Plugin, ViteDevServer } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import localTls, {
  createViteLocalTlsPlugin,
  resolveCaddyTlsDomains,
  resolveCaddyTlsUrl,
  resolveLocalTlsDomains,
  resolveLocalTlsUrl,
  type ViteCaddyTlsPluginOptions,
} from '../../src/index.js';
import type { PluginRuntimeDependencies } from '../../src/interfaces/plugin-runtime.js';

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('legacy public API compatibility', () => {
  it('keeps the old helper names and option type as aliases', () => {
    const options: ViteCaddyTlsPluginOptions = {
      domain: 'app.localhost',
      serverName: 'legacy-team',
      caddyApiUrl: 'http://localhost:2019',
      caddyAdminOrigin: 'http://localhost:2019',
    };

    expect(resolveCaddyTlsDomains(options)).toEqual(resolveLocalTlsDomains(options));
    expect(resolveCaddyTlsUrl(options)).toBe(resolveLocalTlsUrl(options));
    expect(localTls(options)).toMatchObject({ name: '@vampaz/vite-plugin-local-tls' });
  });

  it('maps serverName and warns once for each obsolete Caddy administration option', async () => {
    const httpServer = new EventEmitter() as EventEmitter & {
      listening: boolean;
      address: () => { address: string; family: string; port: number };
    };
    httpServer.listening = true;
    httpServer.address = function address() {
      return { address: '127.0.0.1', family: 'IPv4', port: 5173 };
    };
    const warnings: string[] = [];
    const ensureInfrastructure = vi.fn(async ({ namespace, paths }) => ({
      version: 1 as const,
      pid: process.pid,
      namespace,
      socketPath: paths.socketPath,
      startedAt: new Date().toISOString(),
      protocolVersion: 1,
      port: 443,
      caFingerprint: 'fingerprint',
    }));
    const client = {
      ownerToken: 'owner-token-123456',
      claimedHostnames: [] as string[],
      connected: false,
      connect: vi.fn(async () => undefined),
      register: vi.fn(async () => ['app.localhost']),
      unregister: vi.fn(async () => []),
      heartbeat: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
    };
    const dependencies: PluginRuntimeDependencies = {
      platform: 'darwin',
      logger: {
        info(): void {},
        warn(message): void {
          warnings.push(message);
        },
        error(): void {},
      },
      ensureInfrastructure,
      createControlClient: vi.fn(() => client),
    };
    const plugin = createViteLocalTlsPlugin(
      {
        domain: 'app.localhost',
        serverName: 'legacy-team',
        caddyApiUrl: 'http://localhost:2019',
        caddyAdminOrigin: 'http://localhost:2019',
      },
      dependencies,
    );
    const server = {
      httpServer,
      config: {
        root: '/tmp/app',
        server: { host: true, port: 5173 },
        preview: { host: true, port: 4173 },
      },
    } as unknown as ViteDevServer;

    ((plugin as Plugin).configureServer as (server: ViteDevServer) => void)(server);
    await flushPromises();
    await flushPromises();

    expect(ensureInfrastructure).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'legacy-team' }),
    );
    expect(warnings).toEqual([
      '`caddyApiUrl` is deprecated and ignored because the local TLS service has no HTTP Admin API. Alternate control channels are limited to explicitly injected test infrastructure.',
      '`caddyAdminOrigin` is deprecated and ignored because the local TLS service has no HTTP Admin API.',
    ]);
    httpServer.emit('close');
    await flushPromises();
  });
});
