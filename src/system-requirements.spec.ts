import { describe, expect, it } from 'vitest';
import { assertTlsSystemRequirements, inspectSystemRequirements } from './system-requirements.js';

function finder(executables: Record<string, string>) {
  return function find(name: string): string | null {
    return executables[name] ?? null;
  };
}

describe('system requirements', () => {
  it('finds macOS OpenSSL, Git, and trust capabilities', () => {
    expect(
      inspectSystemRequirements({
        platform: 'darwin',
        find: finder({
          openssl: '/opt/homebrew/bin/openssl',
          git: '/usr/bin/git',
          security: '/usr/bin/security',
        }),
      }),
    ).toMatchObject({
      opensslPath: '/opt/homebrew/bin/openssl',
      gitPath: '/usr/bin/git',
      trustTool: 'security',
      missing: [],
    });
  });

  it('selects supported Linux and WSL trust mechanisms', () => {
    expect(
      inspectSystemRequirements({
        platform: 'linux',
        release: 'generic',
        find: finder({
          openssl: '/usr/bin/openssl',
          'update-ca-trust': '/usr/bin/update-ca-trust',
        }),
      }).trustTool,
    ).toBe('update-ca-trust');
    expect(
      inspectSystemRequirements({
        platform: 'linux',
        release: 'microsoft-standard-WSL2',
        find: finder({ openssl: '/usr/bin/openssl', 'certutil.exe': '/mnt/c/certutil.exe' }),
      }),
    ).toMatchObject({ isWsl: true, trustTool: 'certutil' });
  });

  it('selects the Windows current-user certificate utility', () => {
    expect(
      inspectSystemRequirements({
        platform: 'win32',
        find: finder({
          openssl: 'C:\\OpenSSL\\openssl.exe',
          certutil: 'C:\\Windows\\certutil.exe',
        }),
      }).trustTool,
    ).toBe('certutil');
  });

  it('fails closed with actionable missing prerequisite diagnostics', () => {
    const requirements = inspectSystemRequirements({ platform: 'linux', find: finder({}) });

    expect(() => assertTlsSystemRequirements(requirements)).toThrow(/OpenSSL/);
    expect(() => assertTlsSystemRequirements(requirements)).toThrow(/update-ca-certificates/);
  });
});
