import { X509Certificate } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CertificateManager } from './certificates.js';
import { getStatePaths } from './state-paths.js';

let temporaryDirectory: string;
let paths: ReturnType<typeof getStatePaths>;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-ca-'));
  paths = getStatePaths('test', process.platform, { HOME: temporaryDirectory });
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('CertificateManager CA', () => {
  it('generates a constrained ECDSA CA with private key permissions', async () => {
    const manager = new CertificateManager({ paths, opensslPath: 'openssl' });
    const record = await manager.ensureCertificateAuthority();
    const certificate = new X509Certificate(await readFile(record.certificatePath));
    const keyStats = await stat(record.keyPath);

    expect(certificate.ca).toBe(true);
    expect(certificate.publicKey.asymmetricKeyType).toBe('ec');
    expect(record.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(record.validTo) - Date.now()).toBeLessThanOrEqual(3660 * 24 * 60 * 60 * 1000);
    if (process.platform !== 'win32') {
      expect(keyStats.mode & 0o777).toBe(0o600);
    }
  });

  it('returns the same CA and deduplicates concurrent creation', async () => {
    const manager = new CertificateManager({ paths, opensslPath: 'openssl' });
    const [first, second] = await Promise.all([
      manager.ensureCertificateAuthority(),
      manager.ensureCertificateAuthority(),
    ]);

    expect(first.fingerprint).toBe(second.fingerprint);
    await expect(manager.ensureCertificateAuthority()).resolves.toMatchObject({
      fingerprint: first.fingerprint,
    });
  });

  it('never overwrites an incomplete CA pair', async () => {
    const manager = new CertificateManager({ paths, opensslPath: 'openssl' });
    await manager.ensureCertificateAuthority();
    const certificateBefore = await readFile(paths.caCertificatePath);
    await unlink(paths.caKeyPath);

    const nextManager = new CertificateManager({ paths, opensslPath: 'openssl' });
    await expect(nextManager.ensureCertificateAuthority()).rejects.toThrow(/incomplete/);
    await expect(readFile(paths.caCertificatePath)).resolves.toEqual(certificateBefore);
  });

  it('does not silently replace an expired trusted CA', async () => {
    const manager = new CertificateManager({ paths, opensslPath: 'openssl' });
    const record = await manager.ensureCertificateAuthority();
    const afterExpiration = new Date(Date.parse(record.validTo) + 1000);
    const expiredManager = new CertificateManager({
      paths,
      opensslPath: 'openssl',
      now: () => afterExpiration,
    });
    await chmod(paths.caKeyPath, 0o600);

    await expect(expiredManager.ensureCertificateAuthority()).rejects.toThrow(/expired/);
  });
});
