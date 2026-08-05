import { createServer, get, request, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProxyServer } from './proxy-server.js';
import { RouteRegistry } from './route-registry.js';

let backend: Server;
let proxy: Server;
let backendPort: number;
let proxyPort: number;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
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

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function fetchProxy(
  pathname = '/',
  host = 'app.localhost',
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  trailers: Record<string, string | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const proxyRequest = get(
      { host: '127.0.0.1', port: proxyPort, path: pathname, headers: { Host: host } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
            trailers: response.trailers,
          }),
        );
      },
    );
    proxyRequest.once('error', reject);
  });
}

beforeEach(async () => {
  backend = createServer((backendRequest, response) => {
    if (backendRequest.url === '/stream') {
      response.setHeader('Set-Cookie', ['one=1', 'two=2']);
      response.setHeader('Trailer', 'X-Checksum');
      response.writeHead(206, 'Partial Content');
      response.write('first-');
      setImmediate(() => {
        response.addTrailers({ 'X-Checksum': 'complete' });
        response.end('second');
      });
      return;
    }
    const chunks: Buffer[] = [];
    backendRequest.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    backendRequest.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          method: backendRequest.method,
          url: backendRequest.url,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
  });
  backendPort = await listen(backend);
  const registry = new RouteRegistry();
  registry.register({
    hostname: 'app.localhost',
    ownerToken: 'owner-token-00000001',
    upstreamHost: '127.0.0.1',
    upstreamPort: backendPort,
  });
  const proxyHandler = new ProxyServer({ registry });
  proxy = createServer(proxyHandler.handleRequest.bind(proxyHandler));
  proxyPort = await listen(proxy);
});

afterEach(async () => {
  await Promise.all([close(proxy), close(backend)]);
});

describe('ProxyServer HTTP/1.1', () => {
  it('routes methods, paths, queries, and streaming request bodies by exact Host', async () => {
    const body = 'x'.repeat(256 * 1024);
    const result = await new Promise<string>((resolve, reject) => {
      const proxyRequest = request(
        {
          host: '127.0.0.1',
          port: proxyPort,
          method: 'PATCH',
          path: '/resource?mode=edit',
          headers: { Host: 'APP.LOCALHOST:443' },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () => resolve(Buffer.concat(chunks).toString()));
        },
      );
      proxyRequest.once('error', reject);
      proxyRequest.end(body);
    });

    expect(JSON.parse(result)).toEqual({
      method: 'PATCH',
      url: '/resource?mode=edit',
      body,
    });
  });

  it('preserves status, duplicate cookies, streamed chunks, and trailers', async () => {
    const response = await fetchProxy('/stream');

    expect(response.status).toBe(206);
    expect(response.headers['set-cookie']).toEqual(['one=1', 'two=2']);
    expect(response.body).toBe('first-second');
    expect(response.trailers['x-checksum']).toBe('complete');
  });

  it('returns safe diagnostics for unknown hosts and unavailable upstreams', async () => {
    const unknown = await fetchProxy('/', 'unknown.localhost');
    expect(unknown).toMatchObject({ status: 421 });
    expect(unknown.body).toContain('No local TLS route');

    await close(backend);
    const unavailable = await fetchProxy();
    expect(unavailable.status).toBe(502);
    expect(unavailable.body).toContain('Local upstream unavailable');
    backend = createServer();
  });
});
