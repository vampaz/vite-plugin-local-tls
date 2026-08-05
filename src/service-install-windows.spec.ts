import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatePaths } from './interfaces/state-paths.js';
import { installStartupService, uninstallStartupService } from './service-install.js';

let temporaryDirectory: string;

function statePaths(): StatePaths {
  const stateDirectory = path.join(temporaryDirectory, 'state');
  const runtimeDirectory = path.join(temporaryDirectory, 'runtime', 'test');
  return {
    stateDirectory,
    runtimeDirectory,
    socketPath: 'vite-local-tls-test-pipe',
    lockPath: path.join(runtimeDirectory, 'startup.lock'),
    stateFile: path.join(stateDirectory, 'service.json'),
    certificateDirectory: path.join(stateDirectory, 'certificates'),
    importedCertificateDirectory: path.join(stateDirectory, 'imported'),
    caKeyPath: path.join(stateDirectory, 'ca-key.pem'),
    caCertificatePath: path.join(stateDirectory, 'ca.pem'),
    caStatePath: path.join(stateDirectory, 'ca.json'),
  };
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-task-'));
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('Windows startup service', () => {
  it('creates and removes a limited current-user task with exact arguments', async () => {
    let queryCount = 0;
    const runner = vi.fn(async (_command: string, arguments_: string[]) => {
      if (arguments_[0] === '/Query') {
        queryCount += 1;
        if (queryCount === 1) {
          throw new Error('Task does not exist.');
        }
        return {
          stdout:
            '<Task><Command>C:\\Program Files\\nodejs\\node.exe C:\\project\\dist\\cli.js --service test</Command></Task>',
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    const options = {
      platform: 'win32' as const,
      namespace: 'test',
      paths: statePaths(),
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      cliPath: 'C:\\project\\dist\\cli.js',
      runner,
    };

    await installStartupService(options);

    const createCall = runner.mock.calls.find(([, arguments_]) => arguments_[0] === '/Create');
    expect(createCall?.[0]).toBe('schtasks.exe');
    expect(createCall?.[1]).toContain('LIMITED');
    expect(createCall?.[1]).toContain('Vite Local TLS\\test');
    expect(createCall?.[1].join(' ')).toContain('"C:\\Program Files\\nodejs\\node.exe"');
    expect(createCall?.[1].join(' ')).toContain('--service');

    await uninstallStartupService(options);

    expect(runner).toHaveBeenCalledWith('schtasks.exe', [
      '/Delete',
      '/TN',
      'Vite Local TLS\\test',
      '/F',
    ]);
  });

  it('does not replace a pre-existing task without an ownership record', async () => {
    const runner = vi.fn(async (_command: string, _arguments: string[]) => ({
      stdout: '',
      stderr: '',
    }));
    const options = {
      platform: 'win32' as const,
      namespace: 'test',
      paths: statePaths(),
      nodePath: 'C:\\node.exe',
      cliPath: 'C:\\cli.js',
      runner,
    };

    await expect(installStartupService(options)).rejects.toThrow(/unrelated scheduled task/);
    expect(runner.mock.calls.some(([, arguments_]) => arguments_[0] === '/Create')).toBe(false);
  });
});
