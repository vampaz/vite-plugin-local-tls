import { createServer, get, type Server } from 'node:http';
import { once } from 'node:events';
import { createConnection, createServer as createNetworkServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProxyListenerSet } from './interfaces/proxy-listeners.js';
import { startProxyListeners } from './proxy-listeners.js';
import { ProxyServer } from './proxy-server.js';
import { RouteRegistry } from './route-registry.js';

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
});
