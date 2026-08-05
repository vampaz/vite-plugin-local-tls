import { describe, expect, it } from 'vitest';
import { createAuthority, createRecordingRunner } from '../tests/fixtures/trust-store.js';
import { TrustStore } from './trust-store.js';

describe('WSL trust store', () => {
  it('converts the CA path and manages the Windows current-user Root store', async () => {
    const authority = createAuthority('/home/test/.local/ca.pem');
    let trusted = false;
    const { calls, runner } = createRecordingRunner((command, arguments_) => {
      if (command === 'wslpath') {
        return { stdout: 'C:\\Users\\test\\ca.pem\n', stderr: '' };
      }
      if (arguments_.includes('-addstore')) {
        trusted = true;
      }
      if (arguments_.includes('-delstore')) {
        trusted = false;
      }
      return { stdout: trusted ? authority.fingerprint : '', stderr: '' };
    });
    const store = new TrustStore({
      authority,
      requirements: {
        platform: 'linux',
        isWsl: true,
        opensslPath: '/usr/bin/openssl',
        gitPath: '/usr/bin/git',
        trustTool: 'certutil',
        trustToolPath: '/mnt/c/Windows/System32/certutil.exe',
        missing: [],
      },
      runner,
    });

    await expect(store.install()).resolves.toMatchObject({ trusted: true });
    await expect(store.remove()).resolves.toMatchObject({ trusted: false });
    expect(calls.some(({ command }) => command === 'wslpath')).toBe(true);
    expect(calls.some(({ arguments_ }) => arguments_.includes('C:\\Users\\test\\ca.pem'))).toBe(
      true,
    );
  });

  it('uses the Linux store when Windows interop certutil is unavailable', async () => {
    const authority = createAuthority('/home/test/.local/ca.pem');
    let trusted = false;
    const { calls, runner } = createRecordingRunner((command) => {
      if (command === 'install') {
        trusted = true;
      }
      if (command === 'rm') {
        trusted = false;
      }
      return {
        stdout: command === '/usr/bin/openssl' && trusted ? authority.fingerprint : '',
        stderr: '',
      };
    });
    const store = new TrustStore({
      authority,
      requirements: {
        platform: 'linux',
        isWsl: true,
        opensslPath: '/usr/bin/openssl',
        gitPath: '/usr/bin/git',
        trustTool: 'update-ca-certificates',
        trustToolPath: '/usr/sbin/update-ca-certificates',
        missing: [],
      },
      runner,
      useSudo: false,
    });

    await expect(store.install()).resolves.toMatchObject({ trusted: true });
    await expect(store.remove()).resolves.toMatchObject({ trusted: false });
    expect(calls.some(({ command }) => command === 'wslpath')).toBe(false);
    expect(calls.some(({ command }) => command === 'install')).toBe(true);
  });
});
