import { createHash, randomBytes } from 'node:crypto';
import {
  createServer as createHttpServer,
  request as createUpstreamRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import {
  constants as HTTP2,
  performServerHandshake,
  type ServerHttp2Stream,
  type SecureServerOptions,
} from 'node:http2';
import type { Duplex } from 'node:stream';
import { createServer as createTlsServer } from 'node:tls';
import type { ProxyOptions } from './interfaces/proxy-options.js';
import type { ActiveRoute } from './route-registry.js';

const FORWARDED_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
];
const CORS_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
];
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
];
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function removeRawHeaders(rawHeaders: string[], names: string[]): string[] {
  const excludedNames = new Set(names.map((name) => name.toLowerCase()));
  const headers: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (!excludedNames.has(rawHeaders[index].toLowerCase())) {
      headers.push(rawHeaders[index], rawHeaders[index + 1]);
    }
  }
  return headers;
}

function getAuthorityHostname(authority: string | undefined): string | null {
  if (!authority) {
    return null;
  }
  try {
    return new URL(`http://${authority}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

function sendDiagnostic(response: ServerResponse, statusCode: number, message: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(message),
    'Cache-Control': 'no-store',
  });
  response.end(message);
}

function sendSocketDiagnostic(socket: Duplex, statusCode: number, message: string): void {
  if (socket.destroyed) {
    return;
  }
  socket.end(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function writeUpgradeResponse(
  socket: Duplex,
  response: IncomingMessage,
  upstreamHead: Buffer,
): void {
  const lines = [
    `HTTP/${response.httpVersion} ${response.statusCode ?? 101} ${response.statusMessage ?? 'Switching Protocols'}`,
  ];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  if (upstreamHead.length > 0) {
    socket.write(upstreamHead);
  }
}

function getForwardedFor(request: IncomingMessage): string {
  const existing = request.headers['x-forwarded-for'];
  const existingValue = Array.isArray(existing) ? existing.join(', ') : existing;
  const remoteAddress = request.socket.remoteAddress ?? 'unknown';
  return existingValue ? `${existingValue}, ${remoteAddress}` : remoteAddress;
}

function buildUpstreamHeaders(
  request: IncomingMessage,
  route: ActiveRoute,
  options: Required<Pick<ProxyOptions, 'publicProtocol' | 'publicPort' | 'proxyMarker'>>,
): string[] {
  const headers = removeRawHeaders(request.rawHeaders, [
    'host',
    options.proxyMarker,
    ...FORWARDED_HEADERS,
  ]);
  headers.push('Host', route.upstreamHostHeader ?? request.headers.host ?? route.hostname);
  headers.push('X-Forwarded-For', getForwardedFor(request));
  headers.push('X-Forwarded-Host', request.headers.host ?? route.hostname);
  headers.push('X-Forwarded-Port', String(options.publicPort));
  headers.push('X-Forwarded-Proto', options.publicProtocol);
  headers.push(options.proxyMarker, '1');
  return headers;
}

function buildResponseHeaders(response: IncomingMessage, route: ActiveRoute): string[] {
  if (!route.cors) {
    return [...response.rawHeaders];
  }
  const headers = removeRawHeaders(response.rawHeaders, CORS_HEADERS);
  headers.push('Access-Control-Allow-Origin', route.cors);
  headers.push(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers',
    '*',
  );
  return headers;
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

function buildHttp2UpstreamHeaders(
  headers: IncomingHttpHeaders,
  route: ActiveRoute,
  remoteAddress: string,
  options: Required<Pick<ProxyOptions, 'publicProtocol' | 'publicPort' | 'proxyMarker'>>,
): OutgoingHttpHeaders {
  const upstreamHeaders: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      !name.startsWith(':') &&
      !HOP_BY_HOP_HEADERS.includes(name) &&
      name !== options.proxyMarker
    ) {
      upstreamHeaders[name] = value;
    }
  }
  const authority = getHeaderValue(headers[HTTP2.HTTP2_HEADER_AUTHORITY]) ?? route.hostname;
  const existingForwardedFor = getHeaderValue(headers['x-forwarded-for']);
  upstreamHeaders.host = route.upstreamHostHeader ?? authority;
  upstreamHeaders['x-forwarded-for'] = existingForwardedFor
    ? `${existingForwardedFor}, ${remoteAddress}`
    : remoteAddress;
  upstreamHeaders['x-forwarded-host'] = authority;
  upstreamHeaders['x-forwarded-port'] = String(options.publicPort);
  upstreamHeaders['x-forwarded-proto'] = options.publicProtocol;
  upstreamHeaders[options.proxyMarker] = '1';
  return upstreamHeaders;
}

function buildHttp2ResponseHeaders(
  response: IncomingMessage,
  route: ActiveRoute,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (!HOP_BY_HOP_HEADERS.includes(name)) {
      headers[name] = value;
    }
  }
  if (route.cors) {
    headers['access-control-allow-origin'] = route.cors;
    headers['access-control-allow-methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
    headers['access-control-allow-headers'] = '*';
  }
  return headers;
}

function sendHttp2StreamDiagnostic(
  stream: ServerHttp2Stream,
  status: number,
  message: string,
): void {
  if (stream.destroyed || stream.headersSent) {
    stream.close();
    return;
  }
  stream.respond({
    ':status': status,
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(message),
    'cache-control': 'no-store',
  });
  stream.end(message);
}

export class ProxyServer {
  readonly #options: ProxyOptions &
    Required<Pick<ProxyOptions, 'publicProtocol' | 'publicPort' | 'proxyMarker'>>;

  constructor(options: ProxyOptions) {
    this.#options = {
      ...options,
      publicProtocol: options.publicProtocol ?? 'https',
      publicPort: options.publicPort ?? 443,
      proxyMarker: options.proxyMarker ?? 'x-vite-local-tls-proxy',
    };
  }

  handleRequest(request: IncomingMessage, response: ServerResponse): void {
    if (request.headers[this.#options.proxyMarker] !== undefined) {
      sendDiagnostic(response, 508, 'Local TLS proxy loop detected.');
      return;
    }
    const hostname = getAuthorityHostname(request.headers.host);
    const route = hostname ? this.#options.registry.get(hostname) : undefined;
    if (!route) {
      sendDiagnostic(
        response,
        421,
        hostname
          ? `No local TLS route is registered for ${hostname}.`
          : 'The request did not contain a valid Host header.',
      );
      return;
    }

    const upstreamRequest = createUpstreamRequest({
      host: route.upstreamHost,
      port: route.upstreamPort,
      method: request.method,
      path: request.url,
      headers: buildUpstreamHeaders(request, route, this.#options),
      setHost: false,
    });
    let receivedResponse = false;
    upstreamRequest.once('response', (upstreamResponse) => {
      receivedResponse = true;
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage ?? 'Bad Gateway',
        buildResponseHeaders(upstreamResponse, route),
      );
      upstreamResponse.pipe(response, { end: false });
      upstreamResponse.once('end', () => {
        if (Object.keys(upstreamResponse.trailers).length > 0) {
          response.addTrailers(upstreamResponse.trailers);
        }
        response.end();
      });
      upstreamResponse.once('aborted', () => response.destroy());
      response.once('close', () => upstreamResponse.destroy());
    });
    upstreamRequest.once('error', (error) => {
      if (!receivedResponse) {
        sendDiagnostic(response, 502, `Local upstream unavailable: ${error.message}`);
      } else {
        response.destroy(error);
      }
    });
    request.pipe(upstreamRequest, { end: false });
    request.once('end', () => {
      if (Object.keys(request.trailers).length > 0) {
        upstreamRequest.addTrailers(request.trailers);
      }
      upstreamRequest.end();
    });
    request.once('aborted', () => upstreamRequest.destroy());
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head = Buffer.alloc(0)): void {
    if (request.headers[this.#options.proxyMarker] !== undefined) {
      sendSocketDiagnostic(socket, 508, 'Loop Detected');
      return;
    }
    const hostname = getAuthorityHostname(request.headers.host);
    const route = hostname ? this.#options.registry.get(hostname) : undefined;
    if (!route) {
      sendSocketDiagnostic(socket, 421, 'Misdirected Request');
      return;
    }

    const upstreamRequest = createUpstreamRequest({
      host: route.upstreamHost,
      port: route.upstreamPort,
      method: request.method,
      path: request.url,
      headers: buildUpstreamHeaders(request, route, this.#options),
      setHost: false,
      agent: false,
    });
    upstreamRequest.once('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      writeUpgradeResponse(socket, upstreamResponse, upstreamHead);
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      upstreamSocket.once('error', () => socket.destroy());
      socket.once('error', () => upstreamSocket.destroy());
      upstreamSocket.once('close', () => socket.destroy());
      socket.once('close', () => upstreamSocket.destroy());
    });
    upstreamRequest.once('response', (upstreamResponse) => {
      upstreamResponse.resume();
      sendSocketDiagnostic(socket, 502, 'WebSocket Upgrade Rejected');
    });
    upstreamRequest.once('error', () => {
      sendSocketDiagnostic(socket, 502, 'Bad Gateway');
    });
    upstreamRequest.end();
  }

  handleHttp2Stream(stream: ServerHttp2Stream, headers: IncomingHttpHeaders): void {
    const authority = getHeaderValue(headers[HTTP2.HTTP2_HEADER_AUTHORITY]);
    const hostname = getAuthorityHostname(authority);
    const route = hostname ? this.#options.registry.get(hostname) : undefined;
    if (!route) {
      sendHttp2StreamDiagnostic(
        stream,
        421,
        'No local TLS route is registered for this authority.',
      );
      return;
    }
    if (headers[HTTP2.HTTP2_HEADER_METHOD] !== 'CONNECT' || headers[':protocol'] !== 'websocket') {
      this.#handleHttp2RequestStream(stream, headers, route);
      return;
    }
    const websocketKey = randomBytes(16).toString('base64');
    const expectedAccept = createHash('sha1')
      .update(`${websocketKey}${WEBSOCKET_GUID}`)
      .digest('base64');
    const upstreamHeaders = buildHttp2UpstreamHeaders(
      headers,
      route,
      stream.session?.socket.remoteAddress ?? 'unknown',
      this.#options,
    );
    upstreamHeaders.connection = 'Upgrade';
    upstreamHeaders.upgrade = 'websocket';
    upstreamHeaders['sec-websocket-key'] = websocketKey;
    upstreamHeaders['sec-websocket-version'] =
      getHeaderValue(headers['sec-websocket-version']) ?? '13';

    const upstreamRequest = createUpstreamRequest({
      host: route.upstreamHost,
      port: route.upstreamPort,
      method: 'GET',
      path: getHeaderValue(headers[HTTP2.HTTP2_HEADER_PATH]),
      headers: upstreamHeaders,
      setHost: false,
      agent: false,
    });
    upstreamRequest.once('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      if (upstreamResponse.headers['sec-websocket-accept'] !== expectedAccept) {
        upstreamSocket.destroy();
        sendHttp2StreamDiagnostic(
          stream,
          502,
          'Upstream returned an invalid WebSocket accept key.',
        );
        return;
      }
      const responseHeaders: OutgoingHttpHeaders = { ':status': 200 };
      for (const name of ['sec-websocket-protocol', 'sec-websocket-extensions']) {
        if (upstreamResponse.headers[name] !== undefined) {
          responseHeaders[name] = upstreamResponse.headers[name];
        }
      }
      if (!stream.headersSent) {
        stream.respond(responseHeaders);
      }
      if (upstreamHead.length > 0) {
        stream.write(upstreamHead);
      }
      upstreamSocket.pipe(stream);
      stream.pipe(upstreamSocket);
      upstreamSocket.once('error', () => stream.close());
      stream.once('error', () => upstreamSocket.destroy());
      upstreamSocket.once('close', () => stream.close());
      stream.once('close', () => upstreamSocket.destroy());
    });
    upstreamRequest.once('response', (upstreamResponse) => {
      upstreamResponse.resume();
      sendHttp2StreamDiagnostic(stream, 502, 'Upstream rejected the WebSocket upgrade.');
    });
    upstreamRequest.once('error', () => {
      sendHttp2StreamDiagnostic(stream, 502, 'WebSocket upstream unavailable.');
    });
    upstreamRequest.end();
  }

  #handleHttp2RequestStream(
    stream: ServerHttp2Stream,
    headers: IncomingHttpHeaders,
    route: ActiveRoute,
  ): void {
    const upstreamRequest = createUpstreamRequest({
      host: route.upstreamHost,
      port: route.upstreamPort,
      method: getHeaderValue(headers[HTTP2.HTTP2_HEADER_METHOD]),
      path: getHeaderValue(headers[HTTP2.HTTP2_HEADER_PATH]),
      headers: buildHttp2UpstreamHeaders(
        headers,
        route,
        stream.session?.socket.remoteAddress ?? 'unknown',
        this.#options,
      ),
      setHost: false,
    });
    let receivedResponse = false;
    upstreamRequest.once('response', (upstreamResponse) => {
      receivedResponse = true;
      let trailers: OutgoingHttpHeaders = {};
      stream.respond(
        {
          ':status': upstreamResponse.statusCode ?? 502,
          ...buildHttp2ResponseHeaders(upstreamResponse, route),
        },
        { waitForTrailers: true },
      );
      stream.once('wantTrailers', () => stream.sendTrailers(trailers));
      upstreamResponse.pipe(stream, { end: false });
      upstreamResponse.once('end', () => {
        trailers = upstreamResponse.trailers;
        stream.end();
      });
      upstreamResponse.once('aborted', () => stream.close());
      stream.once('close', () => upstreamResponse.destroy());
    });
    upstreamRequest.once('error', (error) => {
      if (!receivedResponse) {
        sendHttp2StreamDiagnostic(stream, 502, `Local upstream unavailable: ${error.message}`);
      } else {
        stream.close();
      }
    });
    stream.pipe(upstreamRequest, { end: false });
    stream.once('end', () => upstreamRequest.end());
    stream.once('aborted', () => upstreamRequest.destroy());
  }
}

export function createSecureProxyServer(
  proxy: ProxyServer,
  options: SecureServerOptions,
): ReturnType<typeof createTlsServer> {
  const http1Server = createHttpServer(proxy.handleRequest.bind(proxy));
  http1Server.on('upgrade', proxy.handleUpgrade.bind(proxy));
  const server = createTlsServer({
    ...options,
    ALPNProtocols: ['h2', 'http/1.1'],
  });
  server.on('secureConnection', (socket) => {
    if (socket.alpnProtocol === 'h2') {
      const session = performServerHandshake(socket, {
        settings: { ...options.settings, enableConnectProtocol: true },
      });
      session.on('stream', proxy.handleHttp2Stream.bind(proxy));
      return;
    }
    http1Server.emit('connection', socket);
  });
  return server;
}
