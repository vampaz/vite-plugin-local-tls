import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect, type ClientHttp2Session } from 'node:http2';
import { get } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestCertificate } from '../tests/fixtures/test-certificate.js';
import { createSecureProxyServer, ProxyServer } from './proxy-server.js';
import { RouteRegistry } from './route-registry.js';

let temporaryDirectory: string;
let backend: Server;
let proxy: ReturnType<typeof createSecureProxyServer>;
let client: ClientHttp2Session;

function listen(server: Server | ReturnType<typeof createSecureProxyServer>): Promise<number> {
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

function close(server: Server | ReturnType<typeof createSecureProxyServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-http2-'));
  backend = createServer((request, response) => {
    response.statusCode = 206;
    response.setHeader('Set-Cookie', ['one=1', 'two=2']);
    response.end(`${request.method} ${request.url} ${request.headers.host}`);
  });
  const backendPort = await listen(backend);
  const registry = new RouteRegistry();
  registry.register({
    hostname: 'app.localhost',
    ownerToken: 'owner-token-00000001',
    upstreamHost: '127.0.0.1',
    upstreamPort: backendPort,
  });
  const certificate = await createTestCertificate(temporaryDirectory);
  proxy = createSecureProxyServer(new ProxyServer({ registry }), certificate);
  const proxyPort = await listen(proxy);
  client = connect(`https://127.0.0.1:${proxyPort}`, { rejectUnauthorized: false });
});

afterEach(async () => {
  client.close();
  await Promise.all([close(proxy), close(backend)]);
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('HTTP/2 proxy', () => {
  it('translates HTTP/2 requests to the HTTP/1.1 Vite upstream', async () => {
    const result = await new Promise<{ status: number; cookies: string[]; body: string }>(
      (resolve, reject) => {
        const request = client.request({
          ':method': 'POST',
          ':path': '/resource?mode=edit',
          ':authority': 'app.localhost',
        });
        let status = 0;
        let cookies: string[] = [];
        const chunks: Buffer[] = [];
        request.on('response', (headers) => {
          status = Number(headers[':status']);
          cookies = headers['set-cookie'] ?? [];
        });
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () =>
          resolve({ status, cookies, body: Buffer.concat(chunks).toString() }),
        );
        request.once('error', reject);
        request.end('body');
      },
    );

    expect(result).toEqual({
      status: 206,
      cookies: ['one=1', 'two=2'],
      body: 'POST /resource?mode=edit app.localhost',
    });
  });

  it('rejects unknown authorities with an HTTP/2 diagnostic', async () => {
    const status = await new Promise<number>((resolve) => {
      const request = client.request({ ':path': '/', ':authority': 'missing.localhost' });
      request.on('response', (headers) => resolve(Number(headers[':status'])));
      request.resume();
    });

    expect(status).toBe(421);
  });

  it('serves HTTP/1.1 clients through ALPN fallback on the same TLS listener', async () => {
    const address = proxy.address();
    if (!address || typeof address === 'string') {
      throw new Error('Missing proxy address.');
    }
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = get(
        new URL(`https://127.0.0.1:${address.port}/http1`),
        {
          headers: { Host: 'app.localhost' },
          rejectUnauthorized: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      request.once('error', reject);
    });

    expect(result).toEqual({ status: 206, body: 'GET /http1 app.localhost' });
  });
});
