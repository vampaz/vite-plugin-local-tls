import { createHash } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { StatePaths } from './interfaces/state-paths.js';

export function sanitizeNamespace(namespace: string): string {
  const sanitized = namespace
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-');
  const trimmed = sanitized.replace(/^-|-$/g, '') || 'default';
  if (trimmed.length <= 40) {
    return trimmed;
  }
  const hash = createHash('sha256').update(trimmed).digest('hex').slice(0, 12);
  return `${trimmed.slice(0, 27).replace(/-+$/g, '')}-${hash}`;
}

export function getStatePaths(
  namespace = 'default',
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): StatePaths {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const safeNamespace = sanitizeNamespace(namespace);
  const homeDirectory = environment.HOME || environment.USERPROFILE || os.homedir();
  const userName = (environment.USERNAME || environment.USER || os.userInfo().username)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
  const runtimeUserId =
    environment.VITE_LOCAL_TLS_USER_ID || process.getuid?.() || os.userInfo().username;
  const stateDirectory =
    platform === 'win32'
      ? pathApi.join(
          environment.LOCALAPPDATA || homeDirectory,
          'vite-plugin-local-tls',
          safeNamespace,
        )
      : platform === 'darwin'
        ? pathApi.join(
            homeDirectory,
            'Library',
            'Application Support',
            'vite-plugin-local-tls',
            safeNamespace,
          )
        : pathApi.join(
            environment.XDG_STATE_HOME || pathApi.join(homeDirectory, '.local', 'state'),
            'vite-plugin-local-tls',
            safeNamespace,
          );
  const runtimeDirectory =
    platform === 'win32'
      ? stateDirectory
      : pathApi.join(
          environment.XDG_RUNTIME_DIR || os.tmpdir(),
          `vite-plugin-local-tls-${runtimeUserId}`,
          safeNamespace,
        );
  const socketPath =
    platform === 'win32'
      ? `\\\\.\\pipe\\vite-local-tls-${userName}-${safeNamespace}`
      : pathApi.join(runtimeDirectory, 'control.sock');

  return {
    stateDirectory,
    runtimeDirectory,
    socketPath,
    lockPath: pathApi.join(runtimeDirectory, 'startup.lock'),
    stateFile: pathApi.join(stateDirectory, 'service.json'),
    certificateDirectory: pathApi.join(stateDirectory, 'certificates'),
    importedCertificateDirectory: pathApi.join(stateDirectory, 'imported'),
    caKeyPath: pathApi.join(stateDirectory, 'ca-key.pem'),
    caCertificatePath: pathApi.join(stateDirectory, 'ca.pem'),
    caStatePath: pathApi.join(stateDirectory, 'ca.json'),
  };
}

export async function ensureStatePaths(paths: StatePaths): Promise<void> {
  const directories = [
    paths.stateDirectory,
    paths.runtimeDirectory,
    paths.certificateDirectory,
    paths.importedCertificateDirectory,
  ];
  for (const directory of directories) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      await chmod(directory, 0o700);
    }
  }
}
