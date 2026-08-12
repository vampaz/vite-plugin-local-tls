import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import {
  connect,
  constants as HTTP2,
  type ClientHttp2Session,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
} from 'node:http2';
import { get } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestCertificate } from '../tests/fixtures/test-certificate.js';
import { createSecureProxyServer, ProxyServer } from './proxy-server.js';
import { RouteRegistry } from './route-registry.js';

let temporaryDirectory: string;
let backend: Server;
let proxy: ReturnType<typeof createSecureProxyServer>;
let client: ClientHttp2Session;
let serverStream: ServerHttp2Stream | undefined;

const HTTP2_REQUEST_TIMEOUT_MS = 1_000;

class CapturingProxyServer extends ProxyServer {
  override handleHttp2Stream(stream: ServerHttp2Stream, headers: IncomingHttpHeaders): void {
    serverStream = stream;
    super.handleHttp2Stream(stream, headers);
  }
}

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

function requestHttp2(
  method: 'GET' | 'HEAD',
  requestPath: string,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = client.request({
      ':method': method,
      ':path': requestPath,
      ':authority': 'app.localhost',
    });
    let status = 0;
    let headers: IncomingHttpHeaders = {};
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      request.close(HTTP2.NGHTTP2_CANCEL);
      reject(new Error(`Timed out waiting for HTTP/2 ${method} ${requestPath}.`));
    }, HTTP2_REQUEST_TIMEOUT_MS);
    request.on('response', (responseHeaders) => {
      status = Number(responseHeaders[':status']);
      headers = responseHeaders;
    });
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      clearTimeout(timeout);
      resolve({ status, headers, body: Buffer.concat(chunks).toString() });
    });
    request.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    request.end();
  });
}

beforeEach(async () => {
  serverStream = undefined;
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-http2-'));
  backend = createServer((request, response) => {
    function sendResponse(): void {
      response.statusCode = 206;
      response.setHeader('Set-Cookie', ['one=1', 'two=2']);
      response.setHeader('X-Upstream-Method', request.method ?? '');
      response.end(`${request.method} ${request.url} ${request.headers.host}`);
    }
    if (request.url === '/delayed-head') {
      setTimeout(sendResponse, 200);
      return;
    }
    sendResponse();
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
  proxy = createSecureProxyServer(new CapturingProxyServer({ registry }), certificate);
  const proxyPort = await listen(proxy);
  client = connect(`https://127.0.0.1:${proxyPort}`, { rejectUnauthorized: false });
});

afterEach(async () => {
  client.close();
  await Promise.all([close(proxy), close(backend)]);
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('HTTP/2 proxy', () => {
  it('completes GET and HEAD requests with the expected response semantics', async () => {
    const getResult = await requestHttp2('GET', '/get');
    const headResult = await requestHttp2('HEAD', '/head');

    expect(getResult).toMatchObject({
      status: 206,
      body: 'GET /get app.localhost',
    });
    expect(getResult.headers['x-upstream-method']).toBe('GET');
    expect(headResult).toMatchObject({ status: 206, body: '' });
    expect(headResult.headers['x-upstream-method']).toBe('HEAD');
    expect(headResult.headers['set-cookie']).toEqual(['one=1', 'two=2']);
  });

  it('does not respond after the client destroys a stream', async () => {
    const request = client.request({
      ':method': 'HEAD',
      ':path': '/delayed-head',
      ':authority': 'app.localhost',
    });
    request.on('error', () => undefined);
    request.end();
    await vi.waitFor(() => expect(serverStream).toBeDefined());
    const respond = vi.spyOn(serverStream!, 'respond');

    request.close(HTTP2.NGHTTP2_CANCEL);
    await vi.waitFor(() => expect(serverStream?.closed || serverStream?.destroyed).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(respond).not.toHaveBeenCalled();
  });

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
          servername: 'app.localhost',
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

  it('keeps serving after abrupt HTTP/2 stream and session resets', async () => {
    const address = proxy.address();
    if (!address || typeof address === 'string') {
      throw new Error('Missing proxy address.');
    }
    const resettingClients = Array.from({ length: 10 }, () =>
      connect(`https://127.0.0.1:${address.port}`, { rejectUnauthorized: false }),
    );
    await Promise.all(
      resettingClients.map(
        (resettingClient) =>
          new Promise<void>((resolve, reject) => {
            resettingClient.once('connect', resolve);
            resettingClient.once('error', reject);
          }),
      ),
    );
    for (const resettingClient of resettingClients) {
      resettingClient.on('error', () => undefined);
      const request = resettingClient.request({
        ':path': '/',
        ':authority': 'missing.localhost',
      });
      request.on('error', () => undefined);
      request.end();
      request.close(HTTP2.NGHTTP2_CANCEL);
      resettingClient.destroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    const status = await new Promise<number>((resolve, reject) => {
      const request = client.request({ ':path': '/', ':authority': 'app.localhost' });
      request.on('response', (headers) => resolve(Number(headers[':status'])));
      request.once('error', reject);
      request.resume();
    });

    expect(status).toBe(206);
    if (!serverStream?.session) {
      throw new Error('Missing server HTTP/2 stream.');
    }
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(() => serverStream?.session?.emit('error', reset)).not.toThrow();
    expect(() => serverStream?.emit('error', reset)).not.toThrow();
    const writeAfterEnd = Object.assign(new Error('write after end'), {
      code: 'ERR_STREAM_WRITE_AFTER_END',
    });
    expect(() => serverStream?.emit('error', writeAfterEnd)).not.toThrow();

    const nextStatus = await new Promise<number>((resolve, reject) => {
      const request = client.request({ ':path': '/', ':authority': 'app.localhost' });
      request.on('response', (headers) => resolve(Number(headers[':status'])));
      request.once('error', reject);
      request.resume();
    });
    expect(nextStatus).toBe(206);
  });
});
