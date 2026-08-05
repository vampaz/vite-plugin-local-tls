import { chmod, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeControlMessage } from './control-protocol.js';
import { ControlServer } from './control-server.js';
import type { ClientControlMessage, ServerControlMessage } from './interfaces/control-message.js';
import { RouteRegistry } from './route-registry.js';

let temporaryDirectory: string;
let socketPath: string;
let registry: RouteRegistry;
let server: ControlServer;
const sockets: Socket[] = [];

function connect(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    sockets.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function exchange(socket: Socket, message: ClientControlMessage): Promise<ServerControlMessage> {
  return new Promise((resolve) => {
    socket.once('data', (data) => resolve(JSON.parse(String(data).trim()) as ServerControlMessage));
    socket.write(encodeControlMessage(message));
  });
}

function registerMessage(ownerToken: string): ClientControlMessage {
  return {
    version: 1,
    type: 'register',
    requestId: `register-${ownerToken}`,
    routes: [
      {
        hostname: 'app.localhost',
        ownerToken,
        upstreamHost: '127.0.0.1',
        upstreamPort: 5173,
      },
    ],
  };
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-control-'));
  socketPath = path.join(temporaryDirectory, 'nested', 'control.sock');
  registry = new RouteRegistry();
  server = new ControlServer({ socketPath, registry });
  await server.start();
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  await server.stop();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('ControlServer', () => {
  it('uses a private Unix-domain socket and reports health', async () => {
    const stats = await lstat(socketPath);
    const socket = await connect();
    const response = await exchange(socket, {
      version: 1,
      type: 'health',
      requestId: 'health-1',
    });

    expect(stats.mode & 0o777).toBe(0o600);
    expect(response).toEqual({
      version: 1,
      type: 'healthy',
      requestId: 'health-1',
      activeRoutes: 0,
    });
  });

  it('registers routes, reports takeover, and protects the new lease from old cleanup', async () => {
    const oldSocket = await connect();
    const newSocket = await connect();
    await exchange(oldSocket, registerMessage('owner-token-00000001'));
    const lostRoute = new Promise<ServerControlMessage>((resolve) => {
      oldSocket.once('data', (data) =>
        resolve(JSON.parse(String(data).trim()) as ServerControlMessage),
      );
    });

    await exchange(newSocket, registerMessage('owner-token-00000002'));

    await expect(lostRoute).resolves.toMatchObject({
      type: 'route-lost',
      hostname: 'app.localhost',
      ownerToken: 'owner-token-00000001',
    });
    oldSocket.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.get('app.localhost')?.ownerToken).toBe('owner-token-00000002');
  });

  it('removes currently owned routes when a connection closes', async () => {
    const socket = await connect();
    await exchange(socket, registerMessage('owner-token-00000001'));
    await new Promise<void>((resolve) => {
      socket.once('close', resolve);
      socket.end();
    });

    expect(registry.size).toBe(0);
  });

  it('reclaims a stale socket but refuses a non-socket path', async () => {
    await server.stop();
    await writeFile(socketPath, 'not a socket');
    await chmod(socketPath, 0o600);
    server = new ControlServer({ socketPath, registry });

    await expect(server.start()).rejects.toThrow(/non-socket/);
  });

  it('returns protocol errors without mutating state', async () => {
    const socket = await connect();
    const response = await exchange(socket, {
      version: 2,
      type: 'health',
      requestId: 'bad-version',
    } as unknown as ClientControlMessage);

    expect(response).toMatchObject({ type: 'error', code: 'UNSUPPORTED_VERSION' });
    expect(registry.size).toBe(0);
  });
});
