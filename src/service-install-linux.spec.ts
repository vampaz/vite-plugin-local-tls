import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandExecutionOptions } from './interfaces/command-execution-options.js';
import type { StatePaths } from './interfaces/state-paths.js';
import {
  installStartupService,
  isStartupServiceCurrent,
  replaceStartupService,
  serviceDefinitionMatchesInstallation,
  STARTUP_SERVICE_OWNER_MARKER,
  uninstallStartupService,
} from './service-install.js';
import { LocalTlsService } from './service.js';

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
  vi.restoreAllMocks();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('Linux startup service', () => {
  it('orders a current service after its systemd user runtime directory', () => {
    const paths = {
      ...statePaths(),
      runtimeDirectory: '/run/user/501/vite-plugin-local-tls-501/default',
      socketPath: '/run/user/501/vite-plugin-local-tls-501/default/control.sock',
    };
    const runtimeDirectory = path.join(paths.stateDirectory, 'service-runtime');
    const options = {
      platform: 'linux' as const,
      namespace: 'default',
      paths,
      nodePath: '/current/node',
      cliPath: '/current/cli.js',
      homeDirectory: '/home/developer',
      username: 'developer',
      uid: 501,
      definitionDirectory: '/etc/systemd/system',
    };
    const record = {
      version: 2 as const,
      packageVersion: '1.0.0',
      protocolVersion: 1,
      installationState: 'installed' as const,
      platform: 'linux' as const,
      namespace: 'default',
      identifier: 'vite-local-tls-default',
      definitionPath: '/etc/systemd/system/vite-local-tls-default.service',
      nodePath: path.join(runtimeDirectory, 'node'),
      cliPath: path.join(runtimeDirectory, 'cli-default.js'),
      runtimeDirectory,
      controlSocket: null,
      installedAt: '2026-08-28T00:00:00.000Z',
    };
    const definition = [
      `# ${STARTUP_SERVICE_OWNER_MARKER}`,
      '[Unit]',
      'Description=Vite local TLS proxy',
      'After=network.target user-runtime-dir@501.service',
      'Requires=user-runtime-dir@501.service',
      '',
      '[Service]',
      'Type=simple',
      'User=developer',
      'Environment=HOME="/home/developer"',
      `Environment=VITE_LOCAL_TLS_RUNTIME_DIRECTORY="${paths.runtimeDirectory}"`,
      `ExecStart="${record.nodePath}" "${record.cliPath}" "proxy" "start" "--service" "--namespace" "default"`,
      'Restart=on-failure',
      'RestartSec=1',
      'AmbientCapabilities=CAP_NET_BIND_SERVICE',
      'CapabilityBoundingSet=CAP_NET_BIND_SERVICE',
      'NoNewPrivileges=true',
      'PrivateTmp=false',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n');

    expect(serviceDefinitionMatchesInstallation(definition, options, record)).toBe(true);
    expect(
      serviceDefinitionMatchesInstallation(
        definition.replace('Requires=user-runtime-dir@501.service\n', ''),
        options,
        record,
      ),
    ).toBe(false);
  });

  it('runs as the installing user with only the low-port binding capability', async () => {
    let installedDefinition = '';
    const runner = vi.fn(
      async (_command: string, arguments_: string[], _options?: CommandExecutionOptions) => {
        const temporaryPath = arguments_.find((argument) => argument.endsWith('.service.tmp'));
        if (temporaryPath) {
          installedDefinition = await readFile(temporaryPath, 'utf8');
        }
        return { stdout: '', stderr: '' };
      },
    );
    const options = {
      platform: 'linux' as const,
      namespace: 'default',
      paths: statePaths(),
      nodePath: process.execPath,
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
    expect(installedDefinition).toContain('PrivateTmp=false');
    expect(installedDefinition).toContain('VITE_LOCAL_TLS_RUNTIME_DIRECTORY');
    expect(installedDefinition).not.toContain('ProtectSystem=strict');
    expect(installedDefinition).toContain('"--service"');
    expect(installedDefinition).toContain('service-runtime/node');
    expect(installedDefinition).toContain('service-runtime/cli-default.js');
    expect(installedDefinition).not.toContain('User=root');
    expect(runner).toHaveBeenCalledWith(
      'sudo',
      ['--', 'systemctl', 'enable', '--now', 'vite-local-tls-default.service'],
      {
        interactive: true,
      },
    );
    expect(
      runner.mock.calls
        .filter(([command]) => command === 'sudo')
        .every(([, , commandOptions]) => commandOptions?.interactive === true),
    ).toBe(true);

    const callsBeforeMismatch = runner.mock.calls.length;
    await expect(
      uninstallStartupService({
        ...options,
        paths: { ...options.paths, socketPath: '/tmp/not-the-recorded-control.sock' },
        controlSocket: '/tmp/not-the-recorded-control.sock',
      }),
    ).rejects.toThrow(/control channel does not match/);
    expect(runner).toHaveBeenCalledTimes(callsBeforeMismatch);

    await mkdir(path.dirname(result.record!.definitionPath!), { recursive: true });
    await writeFile(result.record!.definitionPath!, installedDefinition);
    await rename(
      path.join(options.paths.stateDirectory, 'service-install-v2.json'),
      path.join(options.paths.stateDirectory, 'service-install-previous.json'),
    );
    await uninstallStartupService(options);

    expect(runner).toHaveBeenCalledWith(
      'sudo',
      ['--', 'rm', '-f', '--', result.record?.definitionPath],
      {
        interactive: true,
      },
    );
    expect(result.record?.nodePath).toContain('service-runtime/node');
    await expect(
      access(path.join(options.paths.stateDirectory, 'service-install-previous.json')),
    ).rejects.toThrow();
  });

  it('detects when the installed service CLI differs from the current package', async () => {
    const cliPath = path.join(temporaryDirectory, 'cli.js');
    const options = {
      platform: 'linux' as const,
      namespace: 'default',
      paths: statePaths(),
      nodePath: process.execPath,
      cliPath,
      homeDirectory: '/home/carlos',
      username: 'carlos',
      definitionDirectory: path.join(temporaryDirectory, 'systemd'),
      runner: vi.fn(async () => ({ stdout: '', stderr: '' })),
      useSudo: true,
    };
    await writeFile(cliPath, "console.log('current');\n");
    await installStartupService(options);

    await expect(isStartupServiceCurrent(options)).resolves.toBe(true);

    await writeFile(cliPath, "console.log('updated');\n");

    await expect(isStartupServiceCurrent(options)).resolves.toBe(false);
  });

  it('restores the previous canonical runtime when an update never becomes ready', async () => {
    const cliPath = path.join(temporaryDirectory, 'cli.js');
    const definitionDirectory = path.join(temporaryDirectory, 'systemd');
    let definition = '';
    let failReadiness = false;
    let pendingRecordDuringUpdate = '';
    const runner = vi.fn(async (_command: string, arguments_: string[]) => {
      if (failReadiness && !pendingRecordDuringUpdate) {
        pendingRecordDuringUpdate = await readFile(
          path.join(statePaths().stateDirectory, 'service-install-v2.json'),
          'utf8',
        );
      }
      const temporaryPath = arguments_.find((argument) => argument.endsWith('.service.tmp'));
      if (temporaryPath) {
        definition = await readFile(temporaryPath, 'utf8');
      }
      return { stdout: '', stderr: '' };
    });
    const options = {
      platform: 'linux' as const,
      namespace: 'default',
      paths: statePaths(),
      nodePath: process.execPath,
      cliPath,
      currentVersion: '1.0.0',
      definitionDirectory,
      runner,
      useSudo: false,
      async waitForServiceReady(): Promise<void> {
        if (failReadiness) {
          throw new Error('Updated unit never became ready.');
        }
      },
    };
    await writeFile(cliPath, "console.log('old');\n");
    const installed = await installStartupService(options);
    await mkdir(definitionDirectory, { recursive: true });
    await writeFile(installed.record!.definitionPath!, definition);
    await writeFile(cliPath, "console.log('new');\n");
    failReadiness = true;
    runner.mockClear();

    await expect(installStartupService({ ...options, currentVersion: '2.0.0' })).rejects.toThrow(
      /never became ready/,
    );

    await expect(readFile(installed.record!.cliPath, 'utf8')).resolves.toBe(
      "console.log('old');\n",
    );
    expect(JSON.parse(pendingRecordDuringUpdate)).toMatchObject({
      packageVersion: '2.0.0',
      installationState: 'installing',
    });
    await expect(
      readFile(path.join(options.paths.stateDirectory, 'service-install-v2.json'), 'utf8'),
    ).resolves.toContain('"packageVersion": "1.0.0"');
    expect(
      runner.mock.calls.some(([, arguments_]) =>
        arguments_.some((argument) => argument.endsWith('.previous.service.tmp')),
      ),
    ).toBe(true);
  });

  it('recovers an interrupted v1-to-v2 update from its durable previous record', async () => {
    const cliPath = path.join(temporaryDirectory, 'cli.js');
    const definitionDirectory = path.join(temporaryDirectory, 'systemd');
    let updating = false;
    let checkedRecoveryVisibility = false;
    let legacyRecordHiddenDuringUpdate = false;
    let previousRecordVisibleDuringUpdate = false;
    const runner = vi.fn(async (command: string, arguments_: string[]) => {
      if (updating && !checkedRecoveryVisibility) {
        checkedRecoveryVisibility = true;
        legacyRecordHiddenDuringUpdate = await access(
          path.join(statePaths().stateDirectory, 'service-install.json'),
        ).then(
          () => false,
          () => true,
        );
        previousRecordVisibleDuringUpdate = await access(
          path.join(statePaths().stateDirectory, 'service-install-previous.json'),
        ).then(
          () => true,
          () => false,
        );
      }
      if (command === 'install' && arguments_.includes('--')) {
        const separator = arguments_.indexOf('--');
        const source = arguments_[separator + 1]!;
        const destination = arguments_[separator + 2]!;
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, await readFile(source));
      }
      return { stdout: '', stderr: '' };
    });
    const options = {
      platform: 'linux' as const,
      namespace: 'default',
      paths: statePaths(),
      nodePath: process.execPath,
      cliPath,
      currentVersion: '1.0.0',
      definitionDirectory,
      runner,
      useSudo: false,
    };
    await writeFile(cliPath, "console.log('old');\n");
    const installed = await installStartupService(options);
    const installedRecord = installed.record!;
    const legacyRecord = {
      version: 1 as const,
      platform: installedRecord.platform,
      namespace: installedRecord.namespace,
      identifier: installedRecord.identifier,
      definitionPath: installedRecord.definitionPath,
      nodePath: installedRecord.nodePath,
      cliPath: installedRecord.cliPath,
      runtimeDirectory: installedRecord.runtimeDirectory,
      controlSocket: installedRecord.controlSocket,
      installedAt: installedRecord.installedAt,
    };
    const recordDirectory = options.paths.stateDirectory;
    const definitionPath = installedRecord.definitionPath!;
    await Promise.all([
      writeFile(
        path.join(recordDirectory, 'service-install.json'),
        `${JSON.stringify(legacyRecord, null, 2)}\n`,
      ),
      writeFile(
        path.join(recordDirectory, 'service-install-previous.json'),
        `${JSON.stringify(legacyRecord, null, 2)}\n`,
      ),
      writeFile(definitionPath, await readFile(definitionPath, 'utf8')),
    ]);
    await writeFile(
      path.join(recordDirectory, 'service-install-v2.json'),
      `${JSON.stringify(
        {
          ...installedRecord,
          version: 2,
          packageVersion: '2.0.0',
          protocolVersion: 1,
          installationState: 'installing',
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(cliPath, "console.log('new');\n");

    updating = true;
    await installStartupService({ ...options, currentVersion: '2.0.0' });

    expect(legacyRecordHiddenDuringUpdate).toBe(true);
    expect(previousRecordVisibleDuringUpdate).toBe(true);
    await expect(readFile(installedRecord.cliPath, 'utf8')).resolves.toBe("console.log('new');\n");
    await expect(readFile(definitionPath, 'utf8')).resolves.toContain(STARTUP_SERVICE_OWNER_MARKER);
    await expect(
      readFile(path.join(recordDirectory, 'service-install-v2.json'), 'utf8'),
    ).resolves.toContain('"packageVersion": "2.0.0"');
    await expect(access(path.join(recordDirectory, 'service-install.json'))).rejects.toThrow();
    await expect(
      access(path.join(recordDirectory, 'service-install-previous.json')),
    ).rejects.toThrow();
  });

  it('refuses to update an owned marker that belongs to another user or runtime', async () => {
    const cliPath = path.join(temporaryDirectory, 'cli.js');
    const definitionDirectory = path.join(temporaryDirectory, 'systemd');
    let definition = '';
    const runner = vi.fn(async (_command: string, arguments_: string[]) => {
      const temporaryPath = arguments_.find((argument) => argument.endsWith('.service.tmp'));
      if (temporaryPath) {
        definition = await readFile(temporaryPath, 'utf8');
      }
      return { stdout: '', stderr: '' };
    });
    const options = {
      platform: 'linux' as const,
      namespace: 'default',
      paths: statePaths(),
      nodePath: process.execPath,
      cliPath,
      homeDirectory: '/home/carlos',
      username: 'carlos',
      definitionDirectory,
      runner,
      useSudo: false,
    };
    await writeFile(cliPath, "console.log('service');\n");
    const installed = await installStartupService(options);
    await mkdir(definitionDirectory, { recursive: true });
    await writeFile(
      installed.record!.definitionPath!,
      definition.replace('User=carlos', 'User=another-developer'),
    );
    runner.mockClear();

    await expect(installStartupService(options)).rejects.toThrow(/unrelated service definition/);
    expect(runner).not.toHaveBeenCalled();

    await writeFile(
      installed.record!.definitionPath!,
      definition.replace(
        '[Service]',
        '[Service]\nEnvironment=NODE_OPTIONS="--import=/tmp/other.js"',
      ),
    );
    await expect(installStartupService(options)).rejects.toThrow(/unrelated service definition/);
    expect(runner).not.toHaveBeenCalled();

    await writeFile(
      installed.record!.definitionPath!,
      [
        '# generated by @vampaz/vite-plugin-local-tls',
        ...definition.split('\n').map((line) => `# ${line}`),
        '[Service]',
        'User=another-developer',
        'ExecStart="/usr/bin/unrelated"',
        '',
      ].join('\n'),
    );
    await expect(installStartupService(options)).rejects.toThrow(/unrelated service definition/);
    expect(runner).not.toHaveBeenCalled();

    const outsideDefinition = path.join(temporaryDirectory, 'outside.service');
    await writeFile(outsideDefinition, definition);
    await unlink(installed.record!.definitionPath!);
    await symlink(outsideDefinition, installed.record!.definitionPath!);
    await expect(installStartupService(options)).rejects.toThrow(/unsafe service definition/);
    expect(runner).not.toHaveBeenCalled();
  });

  it('publishes first-install ownership only after the exact system target is ready', async () => {
    const cliPath = path.join(temporaryDirectory, 'cli.js');
    const paths = statePaths();
    let recordExistedDuringFirstMutation: boolean | null = null;
    const runner = vi.fn(async () => {
      recordExistedDuringFirstMutation ??= await access(
        path.join(paths.stateDirectory, 'service-install-v2.json'),
      ).then(
        () => true,
        () => false,
      );
      return { stdout: '', stderr: '' };
    });
    await writeFile(cliPath, "console.log('service');\n");

    await installStartupService({
      platform: 'linux',
      namespace: 'default',
      paths,
      nodePath: process.execPath,
      cliPath,
      definitionDirectory: path.join(temporaryDirectory, 'systemd'),
      runner,
      useSudo: false,
    });

    expect(recordExistedDuringFirstMutation).toBe(false);
    await expect(
      readFile(path.join(paths.stateDirectory, 'service-install-v2.json'), 'utf8'),
    ).resolves.toContain('"installationState": "installed"');
  });

  it('rejects systemd directive injection through environment-derived values', async () => {
    const runner = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const cliPath = path.join(temporaryDirectory, 'cli.js');
    await writeFile(cliPath, "console.log('service');\n");

    await expect(
      installStartupService({
        platform: 'linux',
        namespace: 'default',
        paths: statePaths(),
        nodePath: process.execPath,
        cliPath,
        homeDirectory: '/home/test\nUser=root',
        username: 'test',
        definitionDirectory: path.join(temporaryDirectory, 'systemd'),
        runner,
        useSudo: true,
      }),
    ).rejects.toThrow(/Home directory contains unsupported control characters/);
    expect(runner).not.toHaveBeenCalled();
  });

  it('rejects a second persistent namespace before touching systemd', async () => {
    const cliPath = path.join(temporaryDirectory, 'cli.js');
    const runner = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await writeFile(cliPath, "console.log('service');\n");

    await expect(
      installStartupService({
        platform: 'linux',
        namespace: 'project-a',
        paths: statePaths(),
        nodePath: process.execPath,
        cliPath,
        definitionDirectory: path.join(temporaryDirectory, 'systemd'),
        runner,
        useSudo: true,
      }),
    ).rejects.toThrow(/one machine-wide startup service/);
    expect(runner).not.toHaveBeenCalled();
  });

  it('disables every owned legacy unit before enabling the canonical service', async () => {
    const canonicalPaths = statePaths();
    const legacyPaths = {
      ...statePaths(),
      stateDirectory: path.join(temporaryDirectory, 'legacy-state'),
      runtimeDirectory: path.join(temporaryDirectory, 'legacy-control-runtime'),
      socketPath: path.join(temporaryDirectory, 'legacy-control-runtime', 'control.sock'),
    };
    const definitionDirectory = path.join(temporaryDirectory, 'systemd');
    const legacyRuntime = path.join(legacyPaths.stateDirectory, 'service-runtime');
    const legacyDefinition = path.join(definitionDirectory, 'vite-local-tls-playground.service');
    const legacyRecord = {
      version: 1 as const,
      platform: 'linux' as const,
      namespace: 'playground',
      identifier: 'vite-local-tls-playground',
      definitionPath: legacyDefinition,
      nodePath: path.join(legacyRuntime, 'node'),
      cliPath: path.join(legacyRuntime, 'cli-playground.js'),
      runtimeDirectory: legacyRuntime,
      controlSocket: null,
      installedAt: '2026-08-28T00:00:00.000Z',
    };
    await Promise.all([
      mkdir(legacyPaths.stateDirectory, { recursive: true }),
      mkdir(legacyRuntime, { recursive: true }),
      mkdir(definitionDirectory, { recursive: true }),
    ]);
    await writeFile(
      path.join(legacyPaths.stateDirectory, 'service-install.json'),
      `${JSON.stringify(legacyRecord)}\n`,
    );
    await writeFile(
      legacyDefinition,
      [
        '# generated by @vampaz/vite-plugin-local-tls',
        '[Unit]',
        'Description=Vite local TLS proxy',
        'After=network.target',
        '',
        '[Service]',
        'Type=simple',
        'User=carlos',
        'Environment=HOME="/home/carlos"',
        `Environment=VITE_LOCAL_TLS_RUNTIME_DIRECTORY="${legacyPaths.runtimeDirectory}"`,
        `ExecStart="${legacyRecord.nodePath}" "${legacyRecord.cliPath}" "proxy" "start" "--service" "--namespace" "playground"`,
        'Restart=on-failure',
        'RestartSec=1',
        'AmbientCapabilities=CAP_NET_BIND_SERVICE',
        'CapabilityBoundingSet=CAP_NET_BIND_SERVICE',
        'NoNewPrivileges=true',
        'PrivateTmp=false',
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        '',
      ].join('\n'),
    );
    const cliPath = path.join(temporaryDirectory, 'cli.js');
    await writeFile(cliPath, "console.log('canonical');\n");
    let failCanonicalStart = true;
    let failReadiness = false;
    let failCleanup = false;
    let canonicalRecordDuringCleanup = '';
    const runner = vi.fn(async (command: string, arguments_: string[]) => {
      if (command === 'install' && arguments_.includes('--')) {
        const separatorIndex = arguments_.indexOf('--');
        const source = arguments_[separatorIndex + 1]!;
        const destination = arguments_[separatorIndex + 2]!;
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, await readFile(source));
      }
      if (
        failCanonicalStart &&
        arguments_[0] === 'enable' &&
        arguments_.includes('vite-local-tls-default.service')
      ) {
        throw new Error('Canonical unit failed to start.');
      }
      if (arguments_[0] === '-f' && arguments_.includes(legacyDefinition)) {
        canonicalRecordDuringCleanup = await readFile(
          path.join(canonicalPaths.stateDirectory, 'service-install-v2.json'),
          'utf8',
        );
        if (failCleanup) {
          throw new Error('Legacy cleanup failed after readiness.');
        }
      }
      return { stdout: '', stderr: '' };
    });
    const canonicalOptions = {
      platform: 'linux' as const,
      namespace: 'default',
      paths: canonicalPaths,
      nodePath: process.execPath,
      cliPath,
      homeDirectory: '/home/carlos',
      username: 'carlos',
      definitionDirectory,
      runner,
      useSudo: false,
      async waitForServiceReady(): Promise<void> {
        if (failReadiness) {
          throw new Error('Canonical unit did not become ready.');
        }
      },
    };
    const legacyOptions = {
      ...canonicalOptions,
      namespace: 'playground',
      paths: legacyPaths,
      runtimeInstallDirectory: legacyRuntime,
    };
    const stopIfIdle = vi.spyOn(LocalTlsService.prototype, 'stopIfIdle').mockResolvedValue(false);

    await expect(replaceStartupService(canonicalOptions, [legacyOptions])).rejects.toThrow(
      /Canonical unit failed to start/,
    );
    expect(runner).not.toHaveBeenCalledWith('systemctl', [
      'enable',
      '--now',
      'vite-local-tls-playground.service',
    ]);
    expect(runner.mock.calls.at(-1)?.[1]).toEqual([
      'disable',
      '--now',
      'vite-local-tls-default.service',
    ]);
    await expect(
      access(path.join(legacyPaths.stateDirectory, 'service-install.json')),
    ).resolves.toBeUndefined();
    await expect(access(legacyRuntime)).resolves.toBeUndefined();

    failCanonicalStart = false;
    failReadiness = true;
    stopIfIdle.mockResolvedValue(true);
    runner.mockClear();
    await expect(replaceStartupService(canonicalOptions, [legacyOptions])).rejects.toThrow(
      /did not become ready/,
    );
    expect(runner).toHaveBeenCalledWith('systemctl', [
      'enable',
      '--now',
      'vite-local-tls-playground.service',
    ]);
    await expect(
      access(path.join(legacyPaths.stateDirectory, 'service-install.json')),
    ).resolves.toBeUndefined();
    await expect(access(legacyRuntime)).resolves.toBeUndefined();

    failReadiness = false;
    failCleanup = true;
    runner.mockClear();
    await expect(replaceStartupService(canonicalOptions, [legacyOptions])).rejects.toThrow(
      /cleanup failed after readiness/,
    );
    await expect(
      readFile(path.join(canonicalPaths.stateDirectory, 'service-install-v2.json'), 'utf8'),
    ).resolves.toContain('"installationState": "installed"');
    await expect(
      access(path.join(legacyPaths.stateDirectory, 'service-install.json')),
    ).resolves.toBeUndefined();

    failCleanup = false;
    runner.mockClear();
    await replaceStartupService(canonicalOptions, [legacyOptions]);

    const commands = runner.mock.calls.map(([, arguments_]) => arguments_);
    const disableIndex = commands.findIndex((arguments_) =>
      arguments_.includes('vite-local-tls-playground.service'),
    );
    const enableIndex = commands.findIndex(
      (arguments_) =>
        arguments_[0] === 'enable' && arguments_.includes('vite-local-tls-default.service'),
    );
    const removeIndex = commands.findIndex(
      (arguments_) => arguments_[0] === '-f' && arguments_.includes(legacyDefinition),
    );
    expect(commands[disableIndex]).toEqual([
      'disable',
      '--now',
      'vite-local-tls-playground.service',
    ]);
    expect(enableIndex).toBeGreaterThan(disableIndex);
    expect(removeIndex).toBeGreaterThan(enableIndex);
    expect(JSON.parse(canonicalRecordDuringCleanup)).toMatchObject({
      installationState: 'installed',
    });
    await expect(
      access(path.join(legacyPaths.stateDirectory, 'service-install.json')),
    ).rejects.toThrow();
    await expect(access(legacyRuntime)).rejects.toThrow();
  });

  it('rejects an alternate persistent control channel before touching systemd', async () => {
    const cliPath = path.join(temporaryDirectory, 'cli.js');
    const runner = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await writeFile(cliPath, "console.log('service');\n");

    await expect(
      installStartupService({
        platform: 'linux',
        namespace: 'default',
        paths: statePaths(),
        nodePath: process.execPath,
        cliPath,
        controlSocket: '/tmp/alternate.sock',
        definitionDirectory: path.join(temporaryDirectory, 'systemd'),
        runner,
        useSudo: true,
      }),
    ).rejects.toThrow(/one control channel/);
    expect(runner).not.toHaveBeenCalled();
  });
});
