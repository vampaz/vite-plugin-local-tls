import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProxyServer } from './proxy-server.js';
import { RouteRegistry } from './route-registry.js';

let backend: Server;
let proxy: Server;
let proxyPort: number;
let backendRequests = 0;

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

function fetch(
  headers: Record<string, string>,
  method = 'GET',
): Promise<{
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const proxyRequest = request(
      { host: '127.0.0.1', port: proxyPort, path: '/', method, headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    proxyRequest.once('error', reject);
    proxyRequest.end();
  });
}

beforeEach(async () => {
  backendRequests = 0;
  backend = createServer((backendRequest, response) => {
    backendRequests += 1;
    response.statusCode = backendRequest.method === 'OPTIONS' ? 405 : 404;
    response.setHeader('Access-Control-Allow-Origin', 'https://backend.example');
    response.end(JSON.stringify(backendRequest.headers));
  });
  const backendPort = await listen(backend);
  const registry = new RouteRegistry();
  registry.register({
    hostname: 'app.localhost',
    ownerToken: 'owner-token-00000001',
    upstreamHost: '127.0.0.1',
    upstreamPort: backendPort,
    cors: 'https://client.localhost',
    upstreamHostHeader: 'localhost:5173',
  });
  const proxyHandler = new ProxyServer({ registry });
  proxy = createServer(proxyHandler.handleRequest.bind(proxyHandler));
  proxyPort = await listen(proxy);
});

afterEach(async () => {
  await Promise.all([close(proxy), close(backend)]);
});

describe('proxy headers', () => {
  it('rewrites Host and appends consistent forwarded headers', async () => {
    const response = await fetch({
      Host: 'app.localhost:443',
      'X-Forwarded-For': '198.51.100.10',
    });
    const headers = JSON.parse(response.body) as Record<string, string>;

    expect(headers.host).toBe('localhost:5173');
    expect(headers['x-forwarded-for']).toMatch(/^198\.51\.100\.10, 127\.0\.0\.1$/);
    expect(headers['x-forwarded-host']).toBe('app.localhost:443');
    expect(headers['x-forwarded-port']).toBe('443');
    expect(headers['x-forwarded-proto']).toBe('https');
    expect(headers['x-vite-local-tls-proxy']).toBe('1');
  });

  it('sets legacy CORS headers without replacing application responses', async () => {
    const response = await fetch({ Host: 'app.localhost' }, 'OPTIONS');

    expect(response.status).toBe(405);
    expect(response.headers['access-control-allow-origin']).toBe('https://client.localhost');
    expect(response.headers['access-control-allow-methods']).toBe(
      'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    );
    expect(response.headers['access-control-allow-headers']).toBe('*');
    expect(backendRequests).toBe(1);
  });

  it('stops marked requests before they can form a proxy loop', async () => {
    const response = await fetch({
      Host: 'app.localhost',
      'X-Vite-Local-Tls-Proxy': '1',
    });

    expect(response.status).toBe(508);
    expect(response.body).toContain('proxy loop');
    expect(backendRequests).toBe(0);
  });
});
