import { X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestCertificate } from '../tests/fixtures/test-certificate.js';
import { createAuthority, createRecordingRunner } from '../tests/fixtures/trust-store.js';
import { TrustStore } from './trust-store.js';

let temporaryDirectory = '';

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = '';
  }
});

describe('macOS trust store', () => {
  it('installs, verifies, and removes only the exact CA fingerprint', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-macos-trust-'));
    const sourceDirectory = path.join(temporaryDirectory, 'source');
    await mkdir(sourceDirectory);
    await createTestCertificate(sourceDirectory);
    const certificatePath = path.join(sourceDirectory, 'certificate.pem');
    const certificatePem = await readFile(certificatePath, 'utf8');
    const fingerprint = new X509Certificate(certificatePem).fingerprint256
      .replaceAll(':', '')
      .toLowerCase();
    const fingerprintSha1 = new X509Certificate(certificatePem).fingerprint
      .replaceAll(':', '')
      .toLowerCase();
    let trusted = false;
    const { calls, runner } = createRecordingRunner((_command, arguments_) => {
      if (arguments_[0] === 'add-trusted-cert') {
        trusted = true;
      }
      if (arguments_[0] === 'delete-certificate') {
        trusted = false;
      }
      return {
        stdout: arguments_[0] === 'find-certificate' && trusted ? certificatePem : '',
        stderr: '',
      };
    });
    const store = new TrustStore({
      authority: {
        ...createAuthority(certificatePath, fingerprint),
        fingerprintSha1,
      },
      requirements: {
        platform: 'darwin',
        isWsl: false,
        opensslPath: '/usr/bin/openssl',
        gitPath: '/usr/bin/git',
        trustTool: 'security',
        trustToolPath: '/usr/bin/security',
        missing: [],
      },
      macosKeychain: '/Users/test/Library/Keychains/login.keychain-db',
      runner,
    });

    await expect(store.install()).resolves.toMatchObject({ trusted: true, fingerprint });
    await expect(store.remove()).resolves.toMatchObject({ trusted: false });
    expect(calls[0]).toMatchObject({
      command: '/usr/bin/security',
      arguments_: [
        'add-trusted-cert',
        '-d',
        '-r',
        'trustRoot',
        '-k',
        '/Users/test/Library/Keychains/login.keychain-db',
        certificatePath,
      ],
      timeoutMs: 30_000,
    });
    expect(calls.some(({ arguments_ }) => arguments_.includes(fingerprintSha1.toUpperCase()))).toBe(
      true,
    );
  });

  it('does not trust a certificate with a similar name but a different fingerprint', async () => {
    const { runner } = createRecordingRunner(() => ({ stdout: '', stderr: '' }));
    const store = new TrustStore({
      authority: createAuthority('/tmp/ca.pem'),
      requirements: {
        platform: 'darwin',
        isWsl: false,
        opensslPath: '/usr/bin/openssl',
        gitPath: null,
        trustTool: 'security',
        trustToolPath: '/usr/bin/security',
        missing: [],
      },
      runner,
    });

    await expect(store.verify()).resolves.toMatchObject({ trusted: false });
  });
});
