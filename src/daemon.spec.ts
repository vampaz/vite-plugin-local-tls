import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { get } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { connect } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestCertificate } from '../tests/fixtures/test-certificate.js';
import { CertificateImportStore } from './certificate-import.js';
import { ControlClient } from './control-client.js';
import { LocalTlsDaemon } from './daemon.js';
import { getStatePaths } from './state-paths.js';

let temporaryDirectory: string;
let namespace: string;
let backend: Server;
let daemon: LocalTlsDaemon;
let client: ControlClient | null;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Missing backend address.'));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-daemon-'));
  namespace = path.basename(temporaryDirectory).slice(-6);
  backend = createServer((_request, response) => response.end('daemon-proxy-ok'));
  client = null;
});

afterEach(async () => {
  await client?.close();
  await daemon?.stop();
  if (backend.listening) {
    await close(backend);
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('LocalTlsDaemon', () => {
  it('acknowledges readiness only after TLS and control are active', async () => {
    const backendPort = await listen(backend);
    const paths = getStatePaths(namespace, process.platform, { HOME: temporaryDirectory });
    daemon = new LocalTlsDaemon({ paths, opensslPath: 'openssl', port: 0, namespace });
    const state = await daemon.start();
    client = new ControlClient({ socketPath: paths.socketPath });
    await client.connect();
    await client.register([
      {
        hostname: 'app.localhost',
        upstreamHost: '127.0.0.1',
        upstreamPort: backendPort,
      },
    ]);
    const authority = await readFile(paths.caCertificatePath);

    const body = await new Promise<string>((resolve, reject) => {
      const request = get(
        new URL(`https://127.0.0.1:${state.port}/`),
        {
          ca: authority,
          servername: 'app.localhost',
          headers: { Host: 'app.localhost' },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () => resolve(Buffer.concat(chunks).toString()));
        },
      );
      request.once('error', reject);
    });

    expect(body).toBe('daemon-proxy-ok');
    expect(await client.health()).toBe(1);
    expect(JSON.parse(await readFile(paths.stateFile, 'utf8'))).toMatchObject({
      pid: process.pid,
      port: state.port,
      socketPath: paths.socketPath,
    });
  });

  it('fails route registration before mutation when a custom certificate import is required', async () => {
    const paths = getStatePaths(namespace, process.platform, { HOME: temporaryDirectory });
    daemon = new LocalTlsDaemon({ paths, opensslPath: 'openssl', port: 0 });
    await daemon.start();
    client = new ControlClient({ socketPath: paths.socketPath });
    await client.connect();

    await expect(
      client.register([
        {
          hostname: 'app.example.test',
          upstreamHost: '127.0.0.1',
          upstreamPort: 5173,
          internalTls: false,
        },
      ]),
    ).rejects.toThrow(/cert import/);
    expect(daemon.registry.size).toBe(0);
  });

  it('serves the exact imported certificate for a custom hostname', async () => {
    const hostname = 'app.example.test';
    const paths = getStatePaths(namespace, process.platform, { HOME: temporaryDirectory });
    const certificate = await createTestCertificate(temporaryDirectory, hostname);
    await new CertificateImportStore({ paths }).importCertificate({
      hostname,
      certificatePath: path.join(temporaryDirectory, 'certificate.pem'),
      keyPath: path.join(temporaryDirectory, 'key.pem'),
    });
    daemon = new LocalTlsDaemon({ paths, opensslPath: 'openssl', port: 0, namespace });
    const state = await daemon.start();
    client = new ControlClient({ socketPath: paths.socketPath });
    await client.connect();
    await client.register([
      {
        hostname,
        upstreamHost: '127.0.0.1',
        upstreamPort: 5173,
        internalTls: false,
      },
    ]);

    const served = await new Promise<X509Certificate>((resolve, reject) => {
      const socket = connect(
        {
          host: '127.0.0.1',
          port: state.port,
          rejectUnauthorized: false,
          servername: hostname,
        },
        () => {
          const peer = socket.getPeerCertificate(true);
          socket.destroy();
          resolve(new X509Certificate(peer.raw));
        },
      );
      socket.once('error', reject);
    });

    const expected = new X509Certificate(certificate.cert);
    expect({
      fingerprint: served.fingerprint256,
      subject: served.subject,
      subjectAltName: served.subjectAltName,
    }).toEqual({
      fingerprint: expected.fingerprint256,
      subject: expected.subject,
      subjectAltName: expected.subjectAltName,
    });
  });

  it('rolls back TLS listeners when the control path is unsafe', async () => {
    const paths = getStatePaths(namespace, process.platform, { HOME: temporaryDirectory });
    await mkdir(path.dirname(paths.socketPath), { recursive: true });
    await writeFile(paths.socketPath, 'not a socket');
    daemon = new LocalTlsDaemon({ paths, opensslPath: 'openssl', port: 0 });

    await expect(daemon.start()).rejects.toThrow(/non-socket/);
    expect(daemon.state).toBeNull();
    await expect(access(paths.stateFile)).rejects.toThrow();
  });

  it('removes state, socket, and owned routes on termination', async () => {
    const paths = getStatePaths(namespace, process.platform, { HOME: temporaryDirectory });
    daemon = new LocalTlsDaemon({ paths, opensslPath: 'openssl', port: 0 });
    await daemon.start();
    client = new ControlClient({ socketPath: paths.socketPath });
    await client.connect();
    await client.register([
      { hostname: 'app.localhost', upstreamHost: '127.0.0.1', upstreamPort: 5173 },
    ]);

    await client.close();
    client = null;
    await daemon.stop();

    expect(daemon.registry.size).toBe(0);
    await expect(access(paths.socketPath)).rejects.toThrow();
    await expect(access(paths.stateFile)).rejects.toThrow();
  });
});
