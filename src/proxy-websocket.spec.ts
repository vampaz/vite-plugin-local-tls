import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebSocketBackend } from '../tests/fixtures/websocket-backend.js';
import { ProxyServer } from './proxy-server.js';
import { RouteRegistry } from './route-registry.js';

let backend: Server;
let proxy: Server;
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

function upgrade(
  hostname: string,
  protocols: string,
  bufferedHead = Buffer.alloc(0),
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(proxyPort, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.once('connect', () => {
      const request = [
        'GET /hmr HTTP/1.1',
        `Host: ${hostname}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Protocol: ${protocols}`,
        'Sec-WebSocket-Extensions: permessage-deflate',
        '',
        '',
      ].join('\r\n');
      socket.write(Buffer.concat([Buffer.from(request), bufferedHead]));
    });
    socket.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
      const result = Buffer.concat(chunks);
      const headerEnd = result.indexOf('\r\n\r\n');
      if (headerEnd >= 0 && result.length >= headerEnd + 4 + bufferedHead.length) {
        socket.destroy();
        resolve(result);
      }
    });
    socket.once('error', reject);
  });
}

beforeEach(async () => {
  backend = createWebSocketBackend();
  const backendPort = await listen(backend);
  const registry = new RouteRegistry();
  registry.register({
    hostname: 'app.localhost',
    ownerToken: 'owner-token-00000001',
    upstreamHost: '127.0.0.1',
    upstreamPort: backendPort,
  });
  const proxyHandler = new ProxyServer({ registry });
  proxy = createServer(proxyHandler.handleRequest.bind(proxyHandler));
  proxy.on('upgrade', proxyHandler.handleUpgrade.bind(proxyHandler));
  proxyPort = await listen(proxy);
});

afterEach(async () => {
  await Promise.all([close(proxy), close(backend)]);
});

describe('WebSocket proxy', () => {
  it('preserves Vite HMR subprotocol and extension negotiation', async () => {
    const response = (await upgrade('app.localhost', 'vite-hmr, chat')).toString();

    expect(response).toContain('101 Switching Protocols');
    expect(response.toLowerCase()).toContain('sec-websocket-protocol: vite-hmr');
    expect(response.toLowerCase()).toContain('sec-websocket-extensions: permessage-deflate');
  });

  it('forwards buffered heads and pipes application WebSocket bytes in both directions', async () => {
    const frame = Buffer.from([0x81, 0x02, 0x68, 0x69]);
    const response = await upgrade('app.localhost', 'chat', frame);
    const headerEnd = response.indexOf('\r\n\r\n');

    expect(response.subarray(headerEnd + 4)).toEqual(frame);
  });

  it('rejects an unknown Host without contacting an upstream', async () => {
    const response = (await upgrade('missing.localhost', 'chat')).toString();
    expect(response).toContain('421 Misdirected Request');
  });
});
