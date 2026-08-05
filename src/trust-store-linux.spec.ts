import { describe, expect, it } from 'vitest';
import { createAuthority, createRecordingRunner } from '../tests/fixtures/trust-store.js';
import type { TrustTool } from './interfaces/system-requirements.js';
import { TrustStore } from './trust-store.js';

function createLinuxStore(tool: TrustTool) {
  const authority = createAuthority('/home/test/.local/ca.pem');
  let trusted = false;
  const { calls, runner } = createRecordingRunner((command, arguments_) => {
    if (command === 'install' || arguments_.includes('--store')) {
      trusted = true;
    }
    if (command === 'rm' || arguments_.includes('--remove')) {
      trusted = false;
    }
    return {
      stdout:
        (command === '/usr/bin/openssl' || arguments_.includes('extract')) && trusted
          ? `sha256 Fingerprint=${authority.fingerprint}`
          : '',
      stderr: '',
    };
  });
  const store = new TrustStore({
    authority,
    requirements: {
      platform: 'linux',
      isWsl: false,
      opensslPath: '/usr/bin/openssl',
      gitPath: '/usr/bin/git',
      trustTool: tool,
      trustToolPath: `/usr/bin/${tool}`,
      missing: [],
    },
    runner,
    useSudo: false,
  });
  return { authority, calls, store };
}

describe('Linux trust stores', () => {
  it('uses the Debian/Ubuntu certificate directory and refresh command', async () => {
    const { calls, store } = createLinuxStore('update-ca-certificates');

    await expect(store.install()).resolves.toMatchObject({ trusted: true });
    await expect(store.remove()).resolves.toMatchObject({ trusted: false });
    expect(
      calls.some(
        ({ command, arguments_ }) => command === 'install' && arguments_[3].endsWith('.crt'),
      ),
    ).toBe(true);
    expect(calls.some(({ command }) => command === '/usr/bin/update-ca-certificates')).toBe(true);
  });

  it('uses Fedora-style anchors and extract refresh', async () => {
    const { calls, store } = createLinuxStore('update-ca-trust');

    await store.install();

    expect(
      calls.some(
        ({ command, arguments_ }) => command === 'install' && arguments_[3].includes('/etc/pki/'),
      ),
    ).toBe(true);
    expect(
      calls.some(
        ({ command, arguments_ }) =>
          command === '/usr/bin/update-ca-trust' && arguments_[0] === 'extract',
      ),
    ).toBe(true);
  });

  it('uses p11-kit trust anchor operations when selected', async () => {
    const { calls, store } = createLinuxStore('trust');
    await store.install();
    await store.remove();

    expect(calls.some(({ arguments_ }) => arguments_.includes('--store'))).toBe(true);
    expect(calls.some(({ arguments_ }) => arguments_.includes('--remove'))).toBe(true);
  });
});
