import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect, type ClientHttp2Session, type IncomingHttpHeaders } from 'node:http2';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestCertificate } from '../tests/fixtures/test-certificate.js';
import { createWebSocketBackend } from '../tests/fixtures/websocket-backend.js';
import { createSecureProxyServer, ProxyServer } from './proxy-server.js';
import { RouteRegistry } from './route-registry.js';

let temporaryDirectory: string;
let backend: Server;
let proxy: ReturnType<typeof createSecureProxyServer>;
let client: ClientHttp2Session;
let registry: RouteRegistry;

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

function waitForConnectProtocol(session: ClientHttp2Session): Promise<void> {
  return new Promise((resolve) => {
    session.on('remoteSettings', (settings) => {
      if (settings.enableConnectProtocol) {
        resolve();
      }
    });
  });
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-http2-ws-'));
  backend = createWebSocketBackend();
  const backendPort = await listen(backend);
  registry = new RouteRegistry();
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
  await waitForConnectProtocol(client);
});

afterEach(async () => {
  client.close();
  await Promise.all([close(proxy), close(backend)]);
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('HTTP/2 WebSocket proxy', () => {
  it('bridges RFC 8441 extended CONNECT and preserves negotiation headers', async () => {
    const frame = Buffer.from([0x81, 0x02, 0x68, 0x69]);
    const result = await new Promise<{ headers: IncomingHttpHeaders; data: Buffer }>(
      (resolve, reject) => {
        const request = client.request({
          ':method': 'CONNECT',
          ':protocol': 'websocket',
          ':scheme': 'https',
          ':authority': 'app.localhost',
          ':path': '/hmr',
          'sec-websocket-protocol': 'vite-hmr, chat',
          'sec-websocket-extensions': 'permessage-deflate',
        });
        let responseHeaders: IncomingHttpHeaders = {};
        const timer = setTimeout(() => {
          request.close();
          reject(
            new Error(
              `Timed out waiting for bridged data after ${JSON.stringify(responseHeaders)}`,
            ),
          );
        }, 2000);
        request.on('response', (headers) => {
          responseHeaders = headers;
          request.write(frame);
        });
        request.once('data', (data) => {
          clearTimeout(timer);
          request.close();
          resolve({ headers: responseHeaders, data: Buffer.from(data) });
        });
        request.once('error', reject);
      },
    );

    expect(result.headers[':status']).toBe(200);
    expect(result.headers['sec-websocket-protocol']).toBe('vite-hmr');
    expect(result.headers['sec-websocket-extensions']).toBe('permessage-deflate');
    expect(result.data).toEqual(frame);
  });

  it('rejects an upstream that does not match the synthesized WebSocket accept key', async () => {
    await close(backend);
    backend = createServer();
    backend.on('upgrade', (_request, socket) => {
      socket.end(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Accept: invalid',
          '',
          '',
        ].join('\r\n'),
      );
    });
    const backendPort = await listen(backend);
    registry.register({
      hostname: 'app.localhost',
      ownerToken: 'owner-token-00000001',
      upstreamHost: '127.0.0.1',
      upstreamPort: backendPort,
    });

    const status = await new Promise<number>((resolve, reject) => {
      const request = client.request({
        ':method': 'CONNECT',
        ':protocol': 'websocket',
        ':scheme': 'https',
        ':authority': 'app.localhost',
        ':path': '/hmr',
      });
      request.on('response', (headers) => resolve(Number(headers[':status'])));
      request.once('error', reject);
      request.resume();
    });

    expect(status).toBe(502);
  });
});
