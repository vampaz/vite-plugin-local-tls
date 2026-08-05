import type { Plugin, UserConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { viteLocalTlsPlugin } from './plugin.js';

interface ViteRuntime {
  createServer: (config: Record<string, unknown>) => Promise<{
    config: {
      server: {
        host?: string | boolean;
        allowedHosts?: string[] | boolean;
        hmr?: boolean | { protocol?: string; host?: string; clientPort?: number };
      };
      preview: { host?: string | boolean; allowedHosts?: string[] | boolean };
    };
    close: () => Promise<void>;
  }>;
}

async function runConfig(options: Parameters<typeof viteLocalTlsPlugin>[0], config: UserConfig) {
  const plugin = viteLocalTlsPlugin(options) as Plugin;
  if (typeof plugin.config !== 'function') {
    throw new Error('Expected a function config hook.');
  }
  const configHook = plugin.config as (
    config: UserConfig,
    environment: { command: 'serve'; mode: string },
  ) => unknown;
  return configHook(config, { command: 'serve', mode: 'development' });
}

async function loadVite3(): Promise<ViteRuntime> {
  return import('vite3') as unknown as Promise<ViteRuntime>;
}

async function loadVite4(): Promise<ViteRuntime> {
  return import('vite4') as unknown as Promise<ViteRuntime>;
}

async function loadVite5(): Promise<ViteRuntime> {
  return import('vite5') as unknown as Promise<ViteRuntime>;
}

async function loadVite6(): Promise<ViteRuntime> {
  return import('vite6') as unknown as Promise<ViteRuntime>;
}

async function loadVite7(): Promise<ViteRuntime> {
  return import('vite7') as unknown as Promise<ViteRuntime>;
}

async function loadVite8(): Promise<ViteRuntime> {
  return import('vite') as unknown as Promise<ViteRuntime>;
}

describe('Vite local TLS plugin config', () => {
  it('defaults dev, preview, and HMR for the first resolved domain', async () => {
    await expect(runConfig({ domain: ['app.localhost', 'api.localhost'] }, {})).resolves.toEqual({
      server: {
        host: true,
        allowedHosts: true,
        hmr: {
          protocol: 'wss',
          host: 'app.localhost',
          clientPort: 443,
        },
      },
      preview: { host: true, allowedHosts: true },
    });
  });

  it('preserves explicit host, allowed-host, and HMR settings', async () => {
    const hmr = { protocol: 'ws' as const, host: 'custom.localhost', clientPort: 3000 };

    await expect(
      runConfig(
        {
          domain: 'app.localhost',
          cors: '*',
          internalTls: false,
          upstreamHostHeader: 'localhost',
          controlSocket: '/tmp/team.sock',
          serviceNamespace: 'team',
        },
        {
          server: { host: '127.0.0.1', allowedHosts: false as unknown as true, hmr },
          preview: { host: '::1', allowedHosts: ['preview.localhost'] },
        },
      ),
    ).resolves.toEqual({
      server: { host: '127.0.0.1', allowedHosts: false, hmr },
      preview: { host: '::1', allowedHosts: ['preview.localhost'] },
    });
  });

  it('does not invent HMR settings when no domain resolves', async () => {
    await expect(runConfig({ domain: [' ', ''] }, {})).resolves.toEqual({
      server: { host: true, allowedHosts: true },
      preview: { host: true, allowedHosts: true },
    });
  });

  it.each([
    ['Vite 3', loadVite3, false],
    ['Vite 4', loadVite4, true],
    ['Vite 5', loadVite5, true],
    ['Vite 6', loadVite6, true],
    ['Vite 7', loadVite7, true],
    ['Vite 8', loadVite8, true],
  ])('executes the plugin contract through %s', async (_name, loadVite, hasPreviewAllowedHosts) => {
    const vite = await loadVite();
    const server = await vite.createServer({
      configFile: false,
      logLevel: 'silent',
      server: { middlewareMode: true },
      plugins: [viteLocalTlsPlugin({ domain: 'version.localhost' })],
    });
    try {
      expect(server.config.server).toMatchObject({
        host: true,
        allowedHosts: true,
        hmr: {
          protocol: 'wss',
          host: 'version.localhost',
          clientPort: 443,
        },
      });
      expect(server.config.preview.host).toBe(true);
      expect(server.config.preview.allowedHosts).toBe(hasPreviewAllowedHosts ? true : undefined);
    } finally {
      await server.close();
    }
  });
});
