import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { defineConfig } from 'vite';
import {
  createViteLocalTlsPlugin,
  resolveLocalTlsDomains,
  viteLocalTlsPlugin,
  type LocalTlsPluginOptions,
} from '@vampaz/vite-plugin-local-tls';
import {
  ControlClient,
  getStatePaths,
  LocalTlsService,
  type PluginRuntimeDependencies,
} from '@vampaz/vite-plugin-local-tls/testing';

const namespace = process.env.VITE_TLS_NAMESPACE ?? 'playground';
const useDefaultInfrastructure = process.env.VITE_TLS_DEFAULT_PATH === 'true';
const proxyPort = useDefaultInfrastructure
  ? 443
  : Number(process.env.VITE_TLS_PROXY_PORT ?? '9443');
const explicitDomains = process.env.VITE_TLS_DOMAINS?.split(',');
const pluginOptions: LocalTlsPluginOptions = explicitDomains ? { domain: explicitDomains } : {};
if (process.env.VITE_TLS_BASE_DOMAIN) {
  pluginOptions.baseDomain = process.env.VITE_TLS_BASE_DOMAIN;
}
if (process.env.VITE_TLS_LOOPBACK_DOMAIN) {
  pluginOptions.loopbackDomain = process.env
    .VITE_TLS_LOOPBACK_DOMAIN as LocalTlsPluginOptions['loopbackDomain'];
}
if (process.env.VITE_TLS_REPO) {
  pluginOptions.repo = process.env.VITE_TLS_REPO;
}
if (process.env.VITE_TLS_BRANCH) {
  pluginOptions.branch = process.env.VITE_TLS_BRANCH;
}
if (process.env.VITE_TLS_INSTANCE_LABEL) {
  pluginOptions.instanceLabel = process.env.VITE_TLS_INSTANCE_LABEL;
}
if (process.env.VITE_TLS_CORS) {
  pluginOptions.cors = process.env.VITE_TLS_CORS;
}
if (process.env.VITE_TLS_UPSTREAM_HOST_HEADER) {
  pluginOptions.upstreamHostHeader = process.env.VITE_TLS_UPSTREAM_HOST_HEADER;
}
if (process.env.VITE_TLS_INTERNAL_TLS === 'true') {
  pluginOptions.internalTls = true;
}
if (process.env.VITE_TLS_INTERNAL_TLS === 'false') {
  pluginOptions.internalTls = false;
}
const domains = resolveLocalTlsDomains(pluginOptions) ?? [];
const paths = getStatePaths(namespace);
const service = new LocalTlsService({
  paths,
  opensslPath: process.env.VITE_TLS_OPENSSL ?? 'openssl',
  namespace,
  port: proxyPort,
});
const dependencies: PluginRuntimeDependencies = {
  platform: process.platform,
  logger: {
    info(message): void {
      console.log(message);
    },
    warn(message): void {
      console.warn(message);
    },
    error(message, error): void {
      console.error(message, error ?? '');
    },
  },
  ensureInfrastructure(): ReturnType<LocalTlsService['ensureRunning']> {
    return service.ensureRunning();
  },
  createControlClient(options): ControlClient {
    return new ControlClient(options);
  },
};

function websocketAccept(key: string): string {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

function decodeWebSocketText(frame: Buffer): string | null {
  const length = frame[1]! & 0x7f;
  if (frame.length < 6 + length || length === 126 || length === 127) {
    return null;
  }
  const mask = frame.subarray(2, 6);
  const payload = frame.subarray(6, 6 + length);
  return Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!)).toString();
}

function encodeWebSocketText(value: string): Buffer {
  const payload = Buffer.from(value);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function handleApplicationWebSocket(request: IncomingMessage, socket: Socket): void {
  if (request.url !== '/app-ws') {
    return;
  }
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.destroy();
    return;
  }
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`,
  );
  socket.on('data', (frame: Buffer) => {
    const message = decodeWebSocketText(frame);
    if (message) {
      socket.write(encodeWebSocketText(`echo:${message}`));
    }
  });
}

export default defineConfig({
  plugins: [
    {
      name: 'fixture-inspection',
      configureServer(server): void {
        server.middlewares.use('/__fixture', (request, response) => {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ headers: request.headers }));
        });
        server.httpServer?.on('upgrade', handleApplicationWebSocket);
      },
    },
    useDefaultInfrastructure
      ? viteLocalTlsPlugin({
          ...pluginOptions,
          serviceNamespace: namespace,
        })
      : createViteLocalTlsPlugin(
          {
            ...pluginOptions,
            serviceNamespace: namespace,
          },
          dependencies,
        ),
  ],
  server: {
    port: Number(process.env.VITE_FIXTURE_PORT ?? '5173'),
    host: process.env.VITE_FIXTURE_HOST ?? '127.0.0.1',
    ...(useDefaultInfrastructure
      ? {}
      : {
          hmr: {
            protocol: 'wss' as const,
            host: domains[0] ?? 'localhost',
            clientPort: proxyPort,
          },
        }),
  },
  preview: {
    port: Number(process.env.VITE_FIXTURE_PORT ?? '4173'),
    host: process.env.VITE_FIXTURE_HOST ?? '127.0.0.1',
  },
});
