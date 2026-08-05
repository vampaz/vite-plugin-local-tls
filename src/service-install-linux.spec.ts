import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    socketPath: path.join(runtimeDirectory, 'control.sock'),
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
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-systemd-'));
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('Linux startup service', () => {
  it('runs as the installing user with only the low-port binding capability', async () => {
    let installedDefinition = '';
    const runner = vi.fn(async (_command: string, arguments_: string[]) => {
      const temporaryPath = arguments_.find((argument) => argument.endsWith('.service.tmp'));
      if (temporaryPath) {
        installedDefinition = await readFile(temporaryPath, 'utf8');
      }
      return { stdout: '', stderr: '' };
    });
    const options = {
      platform: 'linux' as const,
      namespace: 'test',
      paths: statePaths(),
      nodePath: '/usr/bin/node',
      cliPath: path.join(temporaryDirectory, 'cli.js'),
      homeDirectory: '/home/carlos',
      username: 'carlos',
      definitionDirectory: path.join(temporaryDirectory, 'systemd'),
      runner,
      useSudo: true,
    };
    await writeFile(options.cliPath, "console.log('service');\n");

    const result = await installStartupService(options);

    expect(installedDefinition).toContain('User=carlos');
    expect(installedDefinition).toContain('AmbientCapabilities=CAP_NET_BIND_SERVICE');
    expect(installedDefinition).toContain('CapabilityBoundingSet=CAP_NET_BIND_SERVICE');
    expect(installedDefinition).toContain('NoNewPrivileges=true');
    expect(installedDefinition).not.toContain('ProtectSystem=strict');
    expect(installedDefinition).toContain('"--service"');
    expect(installedDefinition).toContain('service-runtime/cli-test.js');
    expect(installedDefinition).not.toContain('User=root');
    expect(runner).toHaveBeenCalledWith('sudo', [
      '--',
      'systemctl',
      'enable',
      '--now',
      'vite-local-tls-test.service',
    ]);

    await uninstallStartupService(options);

    expect(runner).toHaveBeenCalledWith('sudo', [
      '--',
      'rm',
      '-f',
      '--',
      result.record?.definitionPath,
    ]);
  });
});
