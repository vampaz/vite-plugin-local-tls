import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlClient } from './control-client.js';
import { ControlServer } from './control-server.js';
import { RouteRegistry } from './route-registry.js';

let temporaryDirectory: string;
let socketPath: string;
let registry: RouteRegistry;
let server: ControlServer;
const clients: ControlClient[] = [];

function createClient(ownerToken: string, onRouteLost = vi.fn()): ControlClient {
  const client = new ControlClient({ socketPath, ownerToken, onRouteLost });
  clients.push(client);
  return client;
}

function route(hostname: string) {
  return { hostname, upstreamHost: '127.0.0.1', upstreamPort: 5173 };
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-client-'));
  socketPath = path.join(temporaryDirectory, 'control.sock');
  registry = new RouteRegistry();
  server = new ControlServer({ socketPath, registry });
  await server.start();
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  await server.stop();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('ControlClient', () => {
  it('connects, checks health, and manages several independent claims', async () => {
    const client = createClient('owner-token-00000001');
    await client.connect();

    expect(await client.health()).toBe(0);
    await expect(
      client.register([route('app.localhost'), route('api.localhost')]),
    ).resolves.toEqual(['app.localhost', 'api.localhost']);
    expect(await client.heartbeat()).toEqual(['app.localhost', 'api.localhost']);
    expect(await client.unregister(['app.localhost'])).toEqual(['app.localhost']);
    expect(registry.get('api.localhost')).toBeDefined();
  });

  it('receives takeover notifications and cannot unregister the new route', async () => {
    const lostRoute = vi.fn();
    const oldClient = createClient('owner-token-00000001', lostRoute);
    const newClient = createClient('owner-token-00000002');
    await oldClient.connect();
    await newClient.connect();
    await oldClient.register([route('app.localhost')]);

    await newClient.register([route('app.localhost')]);
    await vi.waitFor(() => expect(lostRoute).toHaveBeenCalledOnce());

    expect(await oldClient.unregister(['app.localhost'])).toEqual([]);
    expect(registry.get('app.localhost')?.ownerToken).toBe('owner-token-00000002');
  });

  it('releases remaining claims when the connection closes', async () => {
    const client = createClient('owner-token-00000001');
    await client.connect();
    await client.register([route('app.localhost')]);

    await client.close();

    expect(registry.size).toBe(0);
  });

  it('bounds connection retries and exposes persistent failure', async () => {
    const missingSocket = path.join(temporaryDirectory, 'missing.sock');
    const client = new ControlClient({
      socketPath: missingSocket,
      reconnectAttempts: 1,
      retryDelayMs: 1,
    });

    await expect(client.connect()).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
  });
});
