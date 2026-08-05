import os from 'node:os';
import path from 'node:path';
import type { StatePaths } from './interfaces/state-paths.js';

function sanitizeNamespace(namespace: string): string {
  const sanitized = namespace
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-');
  return sanitized.replace(/^-|-$/g, '') || 'default';
}

export function getStatePaths(
  namespace = 'default',
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): StatePaths {
  const safeNamespace = sanitizeNamespace(namespace);
  const homeDirectory = environment.HOME || environment.USERPROFILE || os.homedir();
  const stateDirectory =
    platform === 'win32'
      ? path.join(environment.LOCALAPPDATA || homeDirectory, 'vite-plugin-local-tls', safeNamespace)
      : platform === 'darwin'
        ? path.join(
            homeDirectory,
            'Library',
            'Application Support',
            'vite-plugin-local-tls',
            safeNamespace,
          )
        : path.join(
            environment.XDG_STATE_HOME || path.join(homeDirectory, '.local', 'state'),
            'vite-plugin-local-tls',
            safeNamespace,
          );
  const runtimeDirectory =
    platform === 'win32'
      ? stateDirectory
      : path.join(
          environment.XDG_RUNTIME_DIR || os.tmpdir(),
          `vite-plugin-local-tls-${process.getuid?.() ?? os.userInfo().username}`,
          safeNamespace,
        );
  const socketPath =
    platform === 'win32'
      ? `\\\\.\\pipe\\vite-local-tls-${os.userInfo().username}-${safeNamespace}`
      : path.join(runtimeDirectory, 'control.sock');

  return {
    stateDirectory,
    runtimeDirectory,
    socketPath,
    lockPath: path.join(runtimeDirectory, 'startup.lock'),
    stateFile: path.join(stateDirectory, 'service.json'),
    certificateDirectory: path.join(stateDirectory, 'certificates'),
  };
}
