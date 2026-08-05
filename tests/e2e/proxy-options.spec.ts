import { X509Certificate } from 'node:crypto';
import { copyFile, mkdtemp, readFile } from 'node:fs/promises';
import { request } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import { CertificateImportStore } from '../../src/certificate-import.js';
import { createTestCertificate } from '../fixtures/test-certificate.js';
import { findAvailablePort, startServer } from '../fixtures/server-process.js';
import { expect, test } from './fixtures.js';

interface HttpsResponse {
  body: string;
  certificate: X509Certificate;
  headers: Record<string, string | string[] | undefined>;
}

function httpsRequest(
  hostname: string,
  port: number,
  certificateAuthority: Buffer | undefined,
  pathname = '/',
  rejectUnauthorized = true,
): Promise<HttpsResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        ca: certificateAuthority,
        rejectUnauthorized,
        servername: hostname,
        headers: { host: hostname },
      },
      (response) => {
        const chunks: Buffer[] = [];
        const peer = (response.socket as TLSSocket).getPeerCertificate(true);
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString(),
            certificate: new X509Certificate(peer.raw),
            headers: response.headers,
          });
        });
      },
    );
    outgoing.once('error', reject);
    outgoing.end();
  });
}

test('injects CORS and rewrites the upstream Host header', async ({ e2e }) => {
  const domain = 'proxy-options.localhost';
  await startServer(e2e, {
    domains: [domain],
    marker: 'proxy-options',
    environment: {
      VITE_TLS_CORS: 'https://client.localhost',
      VITE_TLS_UPSTREAM_HOST_HEADER: 'rewritten.internal:8123',
    },
  });
  const authority = await readFile(e2e.paths.caCertificatePath);
  const response = await httpsRequest(domain, e2e.proxyPort, authority, '/__fixture');
  const inspection = JSON.parse(response.body) as { headers: { host?: string } };

  expect(response.headers['access-control-allow-origin']).toBe('https://client.localhost');
  expect(inspection.headers.host).toBe('rewritten.internal:8123');
});

for (const internalTls of [undefined, true, false] as const) {
  test(`uses the local CA for local domains with internalTls=${String(internalTls)}`, async ({
    e2e,
  }) => {
    const domain = `local-policy-${String(internalTls)}.localhost`;
    await startServer(e2e, {
      domains: [domain],
      marker: domain,
      environment:
        internalTls === undefined ? {} : { VITE_TLS_INTERNAL_TLS: internalTls ? 'true' : 'false' },
    });
    const authority = await readFile(e2e.paths.caCertificatePath);
    const response = await httpsRequest(domain, e2e.proxyPort, authority);

    expect(response.body).toContain('Vite local TLS playground');
  });
}

for (const internalTls of [undefined, true] as const) {
  test(`uses the local CA for custom domains with internalTls=${String(internalTls)}`, async ({
    e2e,
  }) => {
    const domain = `custom-policy-${String(internalTls)}.example.test`;
    await startServer(e2e, {
      domains: [domain],
      marker: domain,
      environment: internalTls === undefined ? {} : { VITE_TLS_INTERNAL_TLS: 'true' },
    });
    const authority = await readFile(e2e.paths.caCertificatePath);
    const response = await httpsRequest(domain, e2e.proxyPort, authority);

    expect(response.body).toContain('Vite local TLS playground');
  });
}

test('requires and then serves an exact imported custom certificate', async ({ e2e }) => {
  const domain = 'imported-policy.example.test';
  const missing = await startServer(e2e, {
    domains: [domain],
    marker: 'missing-import',
    environment: { VITE_TLS_INTERNAL_TLS: 'false' },
    expectedOutput: /vite-local-tls cert import --hostname imported-policy\.example\.test/,
  });
  expect(missing.output()).not.toContain('Local TLS URL:');
  await missing.stop();

  const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-tls-import-'));
  const certificate = await createTestCertificate(sourceDirectory, domain);
  const certificatePath = path.join(sourceDirectory, 'certificate-input.pem');
  const keyPath = path.join(sourceDirectory, 'key-input.pem');
  await copyFile(path.join(sourceDirectory, 'certificate.pem'), certificatePath);
  await copyFile(path.join(sourceDirectory, 'key.pem'), keyPath);
  await new CertificateImportStore({ paths: e2e.paths }).importCertificate({
    hostname: domain,
    certificatePath,
    keyPath,
  });

  await startServer(e2e, {
    domains: [domain],
    marker: 'imported-certificate',
    environment: { VITE_TLS_INTERNAL_TLS: 'false' },
  });
  const response = await httpsRequest(domain, e2e.proxyPort, undefined, '/', false);
  const served = response.certificate;
  const expected = new X509Certificate(certificate.cert);

  expect(response.body).toContain('Vite local TLS playground');
  expect({
    fingerprint: served.fingerprint256,
    issuer: served.issuer,
    subject: served.subject,
    subjectAltName: served.subjectAltName,
  }).toEqual({
    fingerprint: expected.fingerprint256,
    issuer: expected.issuer,
    subject: expected.subject,
    subjectAltName: expected.subjectAltName,
  });
});

for (const fixture of [
  { name: 'wildcard', host: '0.0.0.0', requestHost: '127.0.0.1' },
  { name: 'ipv4', host: '127.0.0.1', requestHost: '127.0.0.1' },
  { name: 'ipv6', host: '::', requestHost: '::1' },
]) {
  test(`proxies a ${fixture.name} Vite bind through its resolved local URL`, async ({ e2e }) => {
    const domain = `${fixture.name}-upstream.localhost`;
    const vitePort = await findAvailablePort(fixture.requestHost);
    const server = await startServer(e2e, {
      domains: [domain],
      marker: `${fixture.name}-upstream`,
      host: fixture.host,
      vitePort,
    });
    const authority = await readFile(e2e.paths.caCertificatePath);
    const response = await httpsRequest(domain, e2e.proxyPort, authority);

    expect(response.body).toContain('Vite local TLS playground');
    expect(server.output()).toContain(`:${vitePort}`);
  });
}
