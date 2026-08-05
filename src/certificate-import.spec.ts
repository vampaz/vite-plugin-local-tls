import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestCertificate } from '../tests/fixtures/test-certificate.js';
import { CertificateImportStore } from './certificate-import.js';
import { getStatePaths } from './state-paths.js';

let temporaryDirectory: string;
let store: CertificateImportStore;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-import-'));
  store = new CertificateImportStore({
    paths: getStatePaths('test', process.platform, { HOME: temporaryDirectory }),
  });
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('CertificateImportStore', () => {
  it('validates and privately stores an exact-host certificate and key', async () => {
    const sourceDirectory = path.join(temporaryDirectory, 'source');
    await mkdir(sourceDirectory);
    await createTestCertificate(sourceDirectory, 'app.example.test');
    const record = await store.importCertificate({
      hostname: 'app.example.test',
      certificatePath: path.join(sourceDirectory, 'certificate.pem'),
      keyPath: path.join(sourceDirectory, 'key.pem'),
    });

    expect(record).toMatchObject({ hostname: 'app.example.test', source: 'imported' });
    await expect(store.createSecureContext('app.example.test')).resolves.toBeDefined();
    if (process.platform !== 'win32') {
      expect((await lstat(record.keyPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(path.dirname(record.keyPath))).mode & 0o777).toBe(0o700);
    }
  });

  it('rejects SAN and private-key mismatches', async () => {
    const firstDirectory = path.join(temporaryDirectory, 'first');
    const secondDirectory = path.join(temporaryDirectory, 'second');
    await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)]);
    await createTestCertificate(firstDirectory, 'app.example.test');
    await createTestCertificate(secondDirectory, 'other.example.test');

    await expect(
      store.importCertificate({
        hostname: 'other.example.test',
        certificatePath: path.join(firstDirectory, 'certificate.pem'),
        keyPath: path.join(firstDirectory, 'key.pem'),
      }),
    ).rejects.toThrow(/exactly DNS:other/);
    await expect(
      store.importCertificate({
        hostname: 'app.example.test',
        certificatePath: path.join(firstDirectory, 'certificate.pem'),
        keyPath: path.join(secondDirectory, 'key.pem'),
      }),
    ).rejects.toThrow(/does not match/);
  });

  it('lists and removes only the requested imported hostname', async () => {
    const oneDirectory = path.join(temporaryDirectory, 'one');
    const twoDirectory = path.join(temporaryDirectory, 'two');
    await Promise.all([mkdir(oneDirectory), mkdir(twoDirectory)]);
    await createTestCertificate(oneDirectory, 'one.example.test');
    await createTestCertificate(twoDirectory, 'two.example.test');
    await store.importCertificate({
      hostname: 'one.example.test',
      certificatePath: path.join(oneDirectory, 'certificate.pem'),
      keyPath: path.join(oneDirectory, 'key.pem'),
    });
    await store.importCertificate({
      hostname: 'two.example.test',
      certificatePath: path.join(twoDirectory, 'certificate.pem'),
      keyPath: path.join(twoDirectory, 'key.pem'),
    });

    expect((await store.listCertificates()).map(({ hostname }) => hostname).sort()).toEqual([
      'one.example.test',
      'two.example.test',
    ]);
    await expect(store.removeCertificate('one.example.test')).resolves.toBe(true);
    await expect(store.getCertificate('one.example.test')).resolves.toBeNull();
    await expect(store.getCertificate('two.example.test')).resolves.toBeDefined();
  });
});
