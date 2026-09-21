import { createServer, get, type Server } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { connect, createConnection, createServer as createNetworkServer } from 'node:net';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyListenerSet } from './interfaces/proxy-listeners.js';
import { startProxyListeners } from './proxy-listeners.js';
import { ProxyServer } from './proxy-server.js';
import { RouteRegistry } from './route-registry.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _command: string,
      _arguments: readonly string[],
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(new Error('lsof unavailable'), '', '');
      return null as never;
    },
  ),
}));

const servers: Server[] = [];
let listeners: ProxyListenerSet | null;

function listen(server: Server, host: string, port = 0): Promise<number> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port, ipv6Only: host === '::1' }, () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Missing server address.'));
        return;
      }
      resolve(address.port);
    });
  });
}

function fetch(host: string, port: number, routeHost: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = get({ host, port, headers: { Host: routeHost } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    request.once('error', reject);
  });
}

function connectionFailure(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once('error', (error) => {
      socket.destroy();
      resolve(error.message);
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
  });
}

beforeEach(() => {
  listeners = null;
});

afterEach(async () => {
  await listeners?.close();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        }),
    ),
  );
});

describe('proxy listeners', () => {
  it('binds only IPv4 and IPv6 loopback and reaches either upstream family', async () => {
    const ipv4Backend = createServer((_request, response) => response.end('ipv4'));
    const ipv6Backend = createServer((_request, response) => response.end('ipv6'));
    const ipv4Port = await listen(ipv4Backend, '127.0.0.1');
    const ipv6Port = await listen(ipv6Backend, '::1');
    const registry = new RouteRegistry();
    registry.register({
      hostname: 'ipv4.localhost',
      ownerToken: 'owner-token-00000001',
      upstreamHost: '127.0.0.1',
      upstreamPort: ipv4Port,
    });
    registry.register({
      hostname: 'ipv6.localhost',
      ownerToken: 'owner-token-00000002',
      upstreamHost: '::1',
      upstreamPort: ipv6Port,
    });
    const handler = new ProxyServer({ registry, publicProtocol: 'http' });
    listeners = await startProxyListeners({
      port: 0,
      createServer: () => createServer(handler.handleRequest.bind(handler)),
    });

    expect(listeners.ipv4.address()).toMatchObject({ address: '127.0.0.1' });
    expect(listeners.ipv6.address()).toMatchObject({ address: '::1' });
    await expect(fetch('::1', listeners.port, 'ipv4.localhost')).resolves.toBe('ipv4');
    await expect(fetch('127.0.0.1', listeners.port, 'ipv6.localhost')).resolves.toBe('ipv6');
  });

  it('exposes only the loopback listeners SECURITY.md promises', async () => {
    listeners = await startProxyListeners({ port: 0, createServer: () => createServer() });

    expect(listeners.ipv4.address()).toMatchObject({
      address: '127.0.0.1',
      family: 'IPv4',
      port: listeners.port,
    });
    expect(listeners.ipv6.address()).toMatchObject({
      address: '::1',
      family: 'IPv6',
      port: listeners.port,
    });

    const nonLoopbackIpv4 = Object.values(os.networkInterfaces())
      .flat()
      .find((entry) => entry?.internal === false && entry.family === 'IPv4');
    if (nonLoopbackIpv4) {
      await expect(connectionFailure(nonLoopbackIpv4.address, listeners.port)).resolves.toContain(
        'ECONNREFUSED',
      );
    }
  });

  it('reports an existing listener and leaves it running', async () => {
    const unrelated = createServer((_request, response) => response.end('unrelated'));
    const occupiedPort = await listen(unrelated, '127.0.0.1');

    await expect(
      startProxyListeners({ port: occupiedPort, createServer: () => createServer() }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE', address: '127.0.0.1' });
    await expect(fetch('127.0.0.1', occupiedPort, 'anything.localhost')).resolves.toBe('unrelated');
  });

  it('closes accepted clients so an idle service can stop promptly', async () => {
    listeners = await startProxyListeners({
      port: 0,
      createServer: () => createNetworkServer(),
    });
    const client = createConnection({ host: '127.0.0.1', port: listeners.port });
    await once(client, 'connect');
    client.on('error', () => undefined);
    const clientClosed = new Promise<void>((resolve) => client.once('close', () => resolve()));

    await listeners.close();
    listeners = null;

    await clientClosed;
    expect(client.destroyed).toBe(true);
  });

  it('closes the IPv4 listener if the matching IPv6 bind fails', async () => {
    const unrelatedIpv6 = createServer();
    const occupiedPort = await listen(unrelatedIpv6, '::1');

    await expect(
      startProxyListeners({ port: occupiedPort, createServer: () => createServer() }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE', address: '::1' });

    const replacementIpv4 = createServer();
    await expect(listen(replacementIpv4, '127.0.0.1', occupiedPort)).resolves.toBe(occupiedPort);
  });

  it('names the conflicting Windows listener from Get-NetTCPConnection', async () => {
    const unrelated = createServer((_request, response) => response.end('unrelated'));
    const occupiedPort = await listen(unrelated, '127.0.0.1');
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.mocked(execFile).mockImplementationOnce(((
      command: string,
      arguments_: string[],
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      expect(command).toBe('powershell');
      expect(arguments_.join(' ')).toContain(
        `Get-NetTCPConnection -LocalPort ${occupiedPort} -State Listen`,
      );
      callback(
        null,
        'OwningProcess ProcessName\r\n-------------- -----------\r\n      4711 node\r\n',
        '',
      );
      return null as never;
    }) as never);
    try {
      const failure = await startProxyListeners({
        port: occupiedPort,
        createServer: () => createServer(),
      }).catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 'EADDRINUSE', address: '127.0.0.1' });
      expect((failure as Error).message).toContain('Existing listener:');
      expect((failure as Error).message).toContain('4711 node');
    } finally {
      platform.mockRestore();
      vi.mocked(execFile).mockClear();
    }
  });

  it('reports a bare conflict when the Windows owner lookup fails', async () => {
    const unrelated = createServer((_request, response) => response.end('unrelated'));
    const occupiedPort = await listen(unrelated, '127.0.0.1');
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.mocked(execFile).mockImplementationOnce(((
      _command: string,
      _arguments: string[],
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(new Error('Get-NetTCPConnection is not available.'), '', '');
      return null as never;
    }) as never);
    try {
      const failure = await startProxyListeners({
        port: occupiedPort,
        createServer: () => createServer(),
      }).catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 'EADDRINUSE', address: '127.0.0.1' });
      expect((failure as Error).message).not.toContain('Existing listener:');
    } finally {
      platform.mockRestore();
      vi.mocked(execFile).mockClear();
    }
  });
});
