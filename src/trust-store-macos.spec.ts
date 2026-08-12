import { describe, expect, it } from 'vitest';
import { createAuthority, createRecordingRunner } from '../tests/fixtures/trust-store.js';
import type { CommandRunner } from './interfaces/trust-store-options.js';
import { TrustStore } from './trust-store.js';

const certificatePath = '/Users/test/Library/Application Support/vite local tls/ca.pem';
const keychainPath = '/Users/test/Library/Keychains/Login Keychain.keychain-db';

function createStore(runner: CommandRunner): TrustStore {
  return new TrustStore({
    authority: createAuthority(certificatePath),
    requirements: {
      platform: 'darwin',
      isWsl: false,
      opensslPath: '/usr/bin/openssl',
      gitPath: '/usr/bin/git',
      trustTool: 'security',
      trustToolPath: '/usr/bin/security',
      missing: [],
    },
    macosKeychain: keychainPath,
    runner,
  });
}

describe('macOS trust store', () => {
  it('accepts a CA that macOS verifies for SSL', async () => {
    const { calls, runner } = createRecordingRunner(() => ({ stdout: '', stderr: '' }));

    await expect(createStore(runner).verify()).resolves.toMatchObject({ trusted: true });
    expect(calls).toEqual([
      {
        command: '/usr/bin/security',
        arguments_: [
          'verify-cert',
          '-c',
          certificatePath,
          '-p',
          'ssl',
          '-k',
          keychainPath,
          '-L',
          '-l',
          '-q',
        ],
        timeoutMs: 30_000,
        options: undefined,
      },
    ]);
  });

  it('rejects a present CA without effective SSL trust', async () => {
    const { runner } = createRecordingRunner(() => {
      throw new Error('CSSMERR_TP_NOT_TRUSTED');
    });

    await expect(createStore(runner).verify()).resolves.toMatchObject({ trusted: false });
  });

  it('repairs rejected trust with an SSL-scoped installation', async () => {
    let trusted = false;
    const { calls, runner } = createRecordingRunner((_command, arguments_) => {
      if (arguments_[0] === 'verify-cert' && !trusted) {
        throw new Error('Malformed or empty trust settings.');
      }
      if (arguments_[0] === 'add-trusted-cert') {
        trusted = true;
      }
      return { stdout: '', stderr: '' };
    });
    const store = createStore(runner);

    await expect(store.verify()).resolves.toMatchObject({ trusted: false });
    await expect(store.install()).resolves.toMatchObject({ trusted: true });
    expect(calls.find(({ arguments_ }) => arguments_[0] === 'add-trusted-cert')).toMatchObject({
      command: '/usr/bin/security',
      arguments_: [
        'add-trusted-cert',
        '-r',
        'trustRoot',
        '-p',
        'ssl',
        '-k',
        keychainPath,
        certificatePath,
      ],
      timeoutMs: 0,
    });
  });

  it('removes the exact CA and reports it as untrusted', async () => {
    let trusted = true;
    const { calls, runner } = createRecordingRunner((_command, arguments_) => {
      if (arguments_[0] === 'delete-certificate') {
        trusted = false;
      }
      if (arguments_[0] === 'verify-cert' && !trusted) {
        throw new Error('CSSMERR_TP_NOT_TRUSTED');
      }
      return { stdout: '', stderr: '' };
    });
    const store = createStore(runner);

    await expect(store.remove()).resolves.toMatchObject({ trusted: false });
    expect(calls.find(({ arguments_ }) => arguments_[0] === 'delete-certificate')).toMatchObject({
      arguments_: [
        'delete-certificate',
        '-Z',
        createAuthority(certificatePath).fingerprintSha1.toUpperCase(),
        keychainPath,
      ],
      timeoutMs: 0,
    });
  });

  it('reports a useful error when SSL trust is still ineffective after installation', async () => {
    const { runner } = createRecordingRunner((_command, arguments_) => {
      if (arguments_[0] === 'verify-cert') {
        throw new Error('CSSMERR_TP_NOT_TRUSTED');
      }
      return { stdout: '', stderr: '' };
    });

    await expect(createStore(runner).install()).rejects.toThrow(/SSL trust/i);
  });
});
