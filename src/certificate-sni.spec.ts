import { X509Certificate } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CertificateManager, createSniCallback } from './certificates.js';
import { getStatePaths } from './state-paths.js';

let temporaryDirectory: string;
let manager: CertificateManager;

const EC_PUBLIC_KEY_OID = Buffer.from('06072a8648ce3d0201', 'hex');

function usesNamedEcParameters(certificate: X509Certificate): boolean {
  const publicKey = Buffer.from(certificate.publicKey.export({ type: 'spki', format: 'der' }));
  const algorithmOffset = publicKey.indexOf(EC_PUBLIC_KEY_OID);
  return algorithmOffset >= 0 && publicKey[algorithmOffset + EC_PUBLIC_KEY_OID.length] === 0x06;
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-leaf-'));
  const registeredHostnames = new Set(['app.localhost']);
  manager = new CertificateManager({
    paths: getStatePaths('test', process.platform, { HOME: temporaryDirectory }),
    opensslPath: 'openssl',
    isHostnameRegistered: (hostname) => registeredHostnames.has(hostname),
  });
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('exact-host certificates', () => {
  it('issues a CA-signed leaf with one exact SAN and a private key', async () => {
    const record = await manager.ensureLeafCertificate('app.localhost');
    const certificate = new X509Certificate(await readFile(record.certificatePath));
    const authority = new X509Certificate(
      await readFile((await manager.ensureCertificateAuthority()).certificatePath),
    );

    expect(certificate.subjectAltName).toBe('DNS:app.localhost');
    expect(certificate.checkHost('app.localhost')).toBe('app.localhost');
    expect(certificate.checkHost('other.localhost')).toBeUndefined();
    expect(certificate.verify(authority.publicKey)).toBe(true);
    if (process.platform !== 'win32') {
      expect((await lstat(record.keyPath)).mode & 0o777).toBe(0o600);
    }
  });

  it.skipIf(process.platform !== 'darwin')(
    'uses named EC parameters with the macOS system OpenSSL',
    async () => {
      const nativeManager = new CertificateManager({
        paths: getStatePaths('test', process.platform, { HOME: temporaryDirectory }),
        opensslPath: '/usr/bin/openssl',
        isHostnameRegistered: (hostname) => hostname === 'app.localhost',
      });
      const record = await nativeManager.ensureLeafCertificate('app.localhost');
      const certificate = new X509Certificate(await readFile(record.certificatePath));

      expect(usesNamedEcParameters(certificate)).toBe(true);
    },
  );

  it('deduplicates concurrent leaf generation and reuses the valid cache', async () => {
    const records = await Promise.all(
      Array.from({ length: 5 }, () => manager.ensureLeafCertificate('app.localhost')),
    );
    expect(new Set(records.map(({ fingerprint }) => fingerprint)).size).toBe(1);
    await expect(manager.ensureLeafCertificate('app.localhost')).resolves.toMatchObject({
      fingerprint: records[0].fingerprint,
    });
  });

  it('refuses unknown SNI names instead of issuing certificates', async () => {
    await expect(manager.ensureLeafCertificate('unknown.localhost')).rejects.toThrow(
      /unregistered/,
    );
    const callback = createSniCallback(manager);
    await expect(
      new Promise((resolve, reject) => {
        callback('unknown.localhost', (error, context) =>
          error ? reject(error) : resolve(context),
        );
      }),
    ).rejects.toThrow(/unregistered/);
  });

  it('creates an SNI secure context only after registration', async () => {
    const callback = createSniCallback(manager);
    await expect(
      new Promise((resolve, reject) => {
        callback('app.localhost', (error, context) => (error ? reject(error) : resolve(context)));
      }),
    ).resolves.toBeDefined();
  });
});
