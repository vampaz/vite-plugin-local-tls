import { lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureStatePaths, getStatePaths } from './state-paths.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('state paths', () => {
  it('uses the macOS Application Support directory and a Unix socket', () => {
    const paths = getStatePaths('Project One', 'darwin', {
      HOME: '/Users/tester',
      VITE_LOCAL_TLS_USER_ID: '501',
    });

    expect(paths.stateDirectory).toBe(
      '/Users/tester/Library/Application Support/vite-plugin-local-tls/project-one',
    );
    expect(paths.socketPath).toMatch(/control\.sock$/);
    expect(paths.runtimeDirectory).toContain('vite-plugin-local-tls-501');
  });

  it('uses XDG directories on Linux and compacts long namespaces', () => {
    const paths = getStatePaths('feature-'.repeat(20), 'linux', {
      HOME: '/home/tester',
      XDG_STATE_HOME: '/state',
      XDG_RUNTIME_DIR: '/run/user/1000',
    });

    expect(paths.stateDirectory).toMatch(/^\/state\/vite-plugin-local-tls\/feature-/);
    expect(path.basename(paths.stateDirectory).length).toBeLessThanOrEqual(40);
    expect(paths.socketPath.length).toBeLessThan(108);
  });

  it('uses a per-user named pipe on Windows', () => {
    const paths = getStatePaths('Default', 'win32', {
      USERPROFILE: 'C:\\Users\\tester',
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
    });

    expect(paths.stateDirectory).toContain('vite-plugin-local-tls');
    expect(paths.socketPath.startsWith('\\\\.\\pipe\\vite-local-tls-')).toBe(true);
  });

  it('creates private state, runtime, certificate, and import directories', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-state-'));
    temporaryDirectories.push(home);
    const paths = getStatePaths('test', process.platform, { HOME: home });

    await ensureStatePaths(paths);

    for (const directory of [
      paths.stateDirectory,
      paths.runtimeDirectory,
      paths.certificateDirectory,
      paths.importedCertificateDirectory,
    ]) {
      const stats = await lstat(directory);
      expect(stats.isDirectory()).toBe(true);
      if (process.platform !== 'win32') {
        expect(stats.mode & 0o777).toBe(0o700);
      }
    }
  });
});
