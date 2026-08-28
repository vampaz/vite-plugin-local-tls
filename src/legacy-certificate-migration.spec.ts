import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestCertificate } from '../tests/fixtures/test-certificate.js';
import { CertificateImportStore } from './certificate-import.js';
import { CertificateManager } from './certificates.js';
import type { DiscoveredStartupServiceInstallation } from './interfaces/service-installation-inventory.js';
import { migrateLegacyCertificateState } from './legacy-certificate-migration.js';
import { getStatePaths } from './state-paths.js';

let temporaryDirectory: string;

function installation(namespace: string): DiscoveredStartupServiceInstallation {
  const paths = getStatePaths(namespace, process.platform, { HOME: temporaryDirectory });
  return {
    recordPath: path.join(paths.stateDirectory, 'service-install.json'),
    paths,
    record: {
      version: 1,
      platform: process.platform,
      namespace,
      identifier: `legacy-${namespace}`,
      definitionPath: null,
      nodePath: '/legacy/node',
      cliPath: '/legacy/cli.js',
      runtimeDirectory: '/legacy/runtime',
      controlSocket: null,
      installedAt: '2026-08-28T00:00:00.000Z',
    },
    options: {
      namespace,
      paths,
      nodePath: '/current/node',
      cliPath: '/current/cli.js',
    },
  };
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-ca-migration-'));
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('legacy certificate-state migration', () => {
  it('adopts the existing trusted authority and exact-host imports into canonical state', async () => {
    const legacy = installation('playground');
    const canonical = getStatePaths('default', process.platform, { HOME: temporaryDirectory });
    const legacyAuthority = await new CertificateManager({
      paths: legacy.paths,
      opensslPath: 'openssl',
    }).ensureCertificateAuthority();
    const sourceCertificateDirectory = path.join(temporaryDirectory, 'source-certificate');
    await mkdir(sourceCertificateDirectory);
    await createTestCertificate(sourceCertificateDirectory, 'app.example.test');
    await new CertificateImportStore({ paths: legacy.paths }).importCertificate({
      hostname: 'app.example.test',
      certificatePath: path.join(sourceCertificateDirectory, 'certificate.pem'),
      keyPath: path.join(sourceCertificateDirectory, 'key.pem'),
    });

    const result = await migrateLegacyCertificateState({
      canonicalPaths: canonical,
      legacyInstallations: [legacy],
      opensslPath: 'openssl',
    });

    const canonicalAuthority = await new CertificateManager({
      paths: canonical,
      opensslPath: 'openssl',
    }).ensureCertificateAuthority();
    expect(canonicalAuthority.fingerprint).toBe(legacyAuthority.fingerprint);
    expect(result).toMatchObject({
      authorityNamespace: 'playground',
      importedHostnames: ['app.example.test'],
      conflicts: [],
    });
    await expect(
      new CertificateImportStore({ paths: canonical }).getCertificate('app.example.test'),
    ).resolves.toBeDefined();
  });

  it('finishes an interrupted two-file authority adoption before certificate startup', async () => {
    const legacy = installation('interrupted');
    const canonical = getStatePaths('default', process.platform, { HOME: temporaryDirectory });
    await new CertificateManager({
      paths: legacy.paths,
      opensslPath: 'openssl',
    }).ensureCertificateAuthority();
    await mkdir(canonical.stateDirectory, { recursive: true });
    await writeFile(
      path.join(canonical.stateDirectory, 'ca-migration.json'),
      `${JSON.stringify({ version: 1, sourceNamespace: 'interrupted' })}\n`,
    );
    await writeFile(canonical.caKeyPath, await readFile(legacy.paths.caKeyPath));

    await migrateLegacyCertificateState({
      canonicalPaths: canonical,
      legacyInstallations: [legacy],
      opensslPath: 'openssl',
    });

    await expect(access(canonical.caCertificatePath)).resolves.toBeUndefined();
    await expect(
      access(path.join(canonical.stateDirectory, 'ca-migration.json')),
    ).rejects.toThrow();
    await expect(
      new CertificateManager({
        paths: canonical,
        opensslPath: 'openssl',
      }).ensureCertificateAuthority(),
    ).resolves.toBeDefined();
  });

  it('prefers a validated authority that is already trusted over a newer untrusted one', async () => {
    const trusted = installation('trusted');
    const newer = installation('newer-untrusted');
    trusted.record.installedAt = '2026-08-27T00:00:00.000Z';
    newer.record.installedAt = '2026-08-28T00:00:00.000Z';
    const canonical = getStatePaths('default', process.platform, { HOME: temporaryDirectory });
    const trustedAuthority = await new CertificateManager({
      paths: trusted.paths,
      opensslPath: 'openssl',
    }).ensureCertificateAuthority();
    await new CertificateManager({
      paths: newer.paths,
      opensslPath: 'openssl',
    }).ensureCertificateAuthority();

    const result = await migrateLegacyCertificateState({
      canonicalPaths: canonical,
      legacyInstallations: [newer, trusted],
      opensslPath: 'openssl',
      async isAuthorityTrusted(authority): Promise<boolean> {
        return authority.fingerprint === trustedAuthority.fingerprint;
      },
    });

    expect(result.authorityNamespace).toBe('trusted');
    await expect(
      new CertificateManager({
        paths: canonical,
        opensslPath: 'openssl',
      }).ensureCertificateAuthority(),
    ).resolves.toMatchObject({ fingerprint: trustedAuthority.fingerprint });
  });

  it.each(['legacy-numeric', 'versioned-json'] as const)(
    'clears a pre-reboot %s migration lock even when its PID has been reused',
    async (format) => {
      const canonical = getStatePaths('default', process.platform, { HOME: temporaryDirectory });
      await mkdir(canonical.stateDirectory, { recursive: true });
      const lockPath = path.join(canonical.stateDirectory, 'ca-migration.lock');
      await writeFile(
        lockPath,
        format === 'legacy-numeric'
          ? `${process.pid}\n`
          : `${JSON.stringify({ pid: process.pid, startedAt: new Date(0).toISOString() })}\n`,
      );
      if (format === 'legacy-numeric') {
        const beforeBoot = new Date(0);
        await utimes(lockPath, beforeBoot, beforeBoot);
      }

      await expect(
        migrateLegacyCertificateState({
          canonicalPaths: canonical,
          legacyInstallations: [],
          opensslPath: 'openssl',
        }),
      ).resolves.toEqual({ authorityNamespace: null, importedHostnames: [], conflicts: [] });
      await expect(access(lockPath)).rejects.toThrow();
    },
  );
});
