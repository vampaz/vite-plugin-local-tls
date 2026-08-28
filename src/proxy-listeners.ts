import { execFile } from 'node:child_process';
import type { Socket } from 'node:net';
import type {
  ProxyListenerOptions,
  ProxyListenerServer,
  ProxyListenerSet,
} from './interfaces/proxy-listeners.js';

export class ProxyListenerError extends Error {
  readonly code?: string;
  readonly address: string;
  readonly port: number;

  constructor(message: string, address: string, port: number, cause: unknown) {
    super(message, { cause });
    this.name = 'ProxyListenerError';
    this.code = (cause as NodeJS.ErrnoException).code;
    this.address = address;
    this.port = port;
  }
}

function listen(server: ProxyListenerServer, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port, ipv6Only: host === '::1' }, () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error(`Listener on ${host} did not expose an address.`));
        return;
      }
      resolve(address.port);
    });
  });
}

function trackConnections(server: ProxyListenerServer): Set<Socket> {
  const connections = new Set<Socket>();
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  return connections;
}

function closeServer(server: ProxyListenerServer, connections: Set<Socket>): Promise<void> {
  if (!server.listening) {
    for (const socket of connections) {
      socket.destroy();
    }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    for (const socket of connections) {
      socket.destroy();
    }
  });
}

function findPortOwner(port: number): Promise<string | null> {
  if (process.platform === 'win32') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(null);
        return;
      }
      resolve(stdout.trim().split('\n').slice(0, 2).join(' | '));
    });
  });
}

async function buildListenerError(
  error: unknown,
  address: string,
  port: number,
): Promise<ProxyListenerError> {
  const code = (error as NodeJS.ErrnoException).code;
  const owner = code === 'EADDRINUSE' ? await findPortOwner(port) : null;
  const detail = owner ? ` Existing listener: ${owner}` : '';
  return new ProxyListenerError(
    `Unable to bind local TLS proxy to ${address}:${port} (${code ?? 'unknown error'}).${detail} The existing listener was left untouched.`,
    address,
    port,
    error,
  );
}

export async function startProxyListeners(
  options: ProxyListenerOptions,
): Promise<ProxyListenerSet> {
  const requestedPort = options.port ?? 443;
  const ipv4 = options.createServer();
  const ipv4Connections = trackConnections(ipv4);
  let port: number;
  try {
    port = await listen(ipv4, '127.0.0.1', requestedPort);
  } catch (error) {
    throw await buildListenerError(error, '127.0.0.1', requestedPort);
  }

  const ipv6 = options.createServer();
  const ipv6Connections = trackConnections(ipv6);
  try {
    await listen(ipv6, '::1', port);
  } catch (error) {
    await closeServer(ipv4, ipv4Connections);
    throw await buildListenerError(error, '::1', port);
  }

  return {
    port,
    ipv4,
    ipv6,
    async close(): Promise<void> {
      await Promise.all([closeServer(ipv4, ipv4Connections), closeServer(ipv6, ipv6Connections)]);
    },
  };
}
