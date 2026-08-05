import { accessSync, constants as FS_CONSTANTS } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SystemRequirements, TrustTool } from './interfaces/system-requirements.js';

type ExecutableFinder = (name: string) => string | null;

function executableNames(name: string, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32' || path.extname(name)) {
    return [name];
  }
  return [name, `${name}.exe`, `${name}.cmd`];
}

export function findExecutable(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const delimiter = platform === 'win32' ? ';' : ':';
  const searchDirectories = (environment.PATH ?? '').split(delimiter).filter(Boolean);
  if (platform === 'win32' && name === 'openssl') {
    searchDirectories.push(
      'C:\\Program Files\\OpenSSL-Win64\\bin',
      'C:\\Program Files\\Git\\usr\\bin',
    );
  }
  for (const directory of searchDirectories) {
    for (const executableName of executableNames(name, platform)) {
      const candidate = pathApi.join(directory, executableName);
      try {
        accessSync(candidate, FS_CONSTANTS.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

function resolveTrustTool(
  platform: NodeJS.Platform,
  isWsl: boolean,
  find: ExecutableFinder,
): { trustTool: TrustTool | null; trustToolPath: string | null } {
  const candidates: Array<{ name: string; tool: TrustTool }> =
    platform === 'darwin'
      ? [{ name: 'security', tool: 'security' }]
      : platform === 'win32'
        ? [{ name: 'certutil', tool: 'certutil' }]
        : isWsl
          ? [
              { name: 'certutil.exe', tool: 'certutil' },
              { name: 'update-ca-certificates', tool: 'update-ca-certificates' },
              { name: 'update-ca-trust', tool: 'update-ca-trust' },
              { name: 'trust', tool: 'trust' },
            ]
          : [
              { name: 'update-ca-certificates', tool: 'update-ca-certificates' },
              { name: 'update-ca-trust', tool: 'update-ca-trust' },
              { name: 'trust', tool: 'trust' },
            ];
  for (const candidate of candidates) {
    const trustToolPath = find(candidate.name);
    if (trustToolPath) {
      return { trustTool: candidate.tool, trustToolPath };
    }
  }
  return { trustTool: null, trustToolPath: null };
}

export function inspectSystemRequirements(
  options: {
    platform?: NodeJS.Platform;
    release?: string;
    find?: ExecutableFinder;
  } = {},
): SystemRequirements {
  const platform = options.platform ?? process.platform;
  const release = options.release ?? os.release();
  const isWsl = platform === 'linux' && /microsoft|wsl/i.test(release);
  const find = options.find ?? ((name) => findExecutable(name, process.env, platform));
  const opensslPath = find('openssl');
  const gitPath = find('git');
  const trust = resolveTrustTool(platform, isWsl, find);
  const missing: string[] = [];
  if (!opensslPath) {
    missing.push(
      'OpenSSL is required to generate local TLS certificates. Install openssl and ensure it is on PATH.',
    );
  }
  if (!trust.trustToolPath) {
    missing.push(
      platform === 'darwin'
        ? 'macOS `security` is required to trust the local CA.'
        : platform === 'win32'
          ? 'Windows `certutil` is required to trust the local CA.'
          : 'A Linux trust tool is required: update-ca-certificates, update-ca-trust, or trust.',
    );
  }

  return {
    platform,
    isWsl,
    opensslPath,
    gitPath,
    ...trust,
    missing,
  };
}

export function assertTlsSystemRequirements(requirements: SystemRequirements): void {
  if (requirements.missing.length > 0) {
    throw new Error(
      `Local TLS prerequisites are unavailable:\n- ${requirements.missing.join('\n- ')}`,
    );
  }
}
