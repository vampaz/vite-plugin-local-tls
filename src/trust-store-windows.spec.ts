import { describe, expect, it } from 'vitest';
import { createAuthority, createRecordingRunner } from '../tests/fixtures/trust-store.js';
import { TrustStore } from './trust-store.js';

describe('Windows trust store', () => {
  it('installs, verifies, and removes the exact fingerprint from the current-user Root store', async () => {
    const authority = createAuthority('C:\\Users\\test\\ca.pem');
    let trusted = false;
    const { calls, runner } = createRecordingRunner((_command, arguments_) => {
      if (arguments_.includes('-addstore')) {
        trusted = true;
      }
      if (arguments_.includes('-delstore')) {
        trusted = false;
      }
      return { stdout: trusted ? `Cert Hash(sha256): ${authority.fingerprint}` : '', stderr: '' };
    });
    const store = new TrustStore({
      authority,
      requirements: {
        platform: 'win32',
        isWsl: false,
        opensslPath: 'C:\\OpenSSL\\openssl.exe',
        gitPath: null,
        trustTool: 'certutil',
        trustToolPath: 'C:\\Windows\\System32\\certutil.exe',
        missing: [],
      },
      runner,
    });

    await expect(store.install()).resolves.toMatchObject({ trusted: true });
    await expect(store.remove()).resolves.toMatchObject({ trusted: false });
    expect(
      calls.some(({ arguments_ }) => arguments_.slice(0, 3).join(' ') === '-user -addstore Root'),
    ).toBe(true);
    expect(
      calls.some(({ arguments_ }) => arguments_.slice(0, 3).join(' ') === '-user -delstore Root'),
    ).toBe(true);
  });

  it('does not accept a display-name match without the exact fingerprint', async () => {
    const { runner } = createRecordingRunner(() => ({
      stdout: 'Vite Local TLS Development CA\nCert Hash(sha256): deadbeef',
      stderr: '',
    }));
    const store = new TrustStore({
      authority: createAuthority('C:\\ca.pem'),
      requirements: {
        platform: 'win32',
        isWsl: false,
        opensslPath: 'openssl.exe',
        gitPath: null,
        trustTool: 'certutil',
        trustToolPath: 'certutil.exe',
        missing: [],
      },
      runner,
    });

    await expect(store.verify()).resolves.toMatchObject({ trusted: false });
  });
});
