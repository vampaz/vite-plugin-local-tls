import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatePaths } from './interfaces/state-paths.js';
import {
  installStartupService,
  replaceStartupService,
  startStartupService,
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

function taskXml(command: string, arguments_: string, extraAction = ''): string {
  return `<Task><Actions><Exec><Command>${command}</Command><Arguments>${arguments_}</Arguments></Exec>${extraAction}</Actions></Task>`;
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-task-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('Windows startup service', () => {
  it('creates and removes a current-user logon task with a durable runtime copy', async () => {
    let queryCount = 0;
    const sourceNodePath = path.join(temporaryDirectory, 'node.exe');
    const sourceCliPath = path.join(temporaryDirectory, 'cli.js');
    const runtimeDirectory = path.join(temporaryDirectory, 'r');
    const installedNodePath = path.join(runtimeDirectory, 'n.exe');
    const configurationPath = path.join(runtimeDirectory, 's.json');
    vi.stubEnv('LOCALAPPDATA', runtimeDirectory);
    await writeFile(sourceNodePath, 'node');
    await writeFile(sourceCliPath, "console.log('service');\n");
    const runner = vi.fn(async (_command: string, arguments_: string[]) => {
      if (arguments_[0] === '/Query') {
        queryCount += 1;
        if (queryCount === 1) {
          throw new Error('Task does not exist.');
        }
        return {
          stdout: taskXml(
            installedNodePath,
            `&quot;${path.join(runtimeDirectory, 'c.js')}&quot; proxy start --service --service-config &quot;${configurationPath}&quot;`,
          ),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    const options = {
      platform: 'win32' as const,
      namespace: 'default',
      paths: statePaths(),
      nodePath: sourceNodePath,
      cliPath: sourceCliPath,
      runtimeInstallDirectory: runtimeDirectory,
      runner,
    };

    const installed = await installStartupService(options);

    const createCall = runner.mock.calls.find(([, arguments_]) => arguments_[0] === '/Create');
    expect(createCall?.[0]).toBe('schtasks.exe');
    expect(createCall?.[1]).toContain('LIMITED');
    expect(createCall?.[1]).toContain('ONLOGON');
    expect(createCall?.[1]).toContain('Vite Local TLS\\default');
    expect(createCall?.[1]).not.toContain('/F');
    expect(createCall?.[1].join(' ')).toContain('%LOCALAPPDATA%\\n.exe');
    expect(createCall?.[1].join(' ')).toContain('%LOCALAPPDATA%\\c.js');
    expect(createCall?.[1].join(' ')).toContain('%LOCALAPPDATA%\\s.json');
    expect(createCall?.[1][createCall[1].indexOf('/TR') + 1].length).toBeLessThanOrEqual(261);
    expect(installed.record?.nodePath).toBe(installedNodePath);
    await expect(readFile(configurationPath, 'utf8')).resolves.toContain('"namespace": "default"');

    await uninstallStartupService(options);

    expect(runner).toHaveBeenCalledWith('schtasks.exe', [
      '/Delete',
      '/TN',
      'Vite Local TLS\\default',
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
      namespace: 'default',
      paths: statePaths(),
      nodePath: 'C:\\node.exe',
      cliPath: path.join(temporaryDirectory, 'cli.js'),
      runner,
    };
    await writeFile(options.cliPath, "console.log('service');\n");

    await expect(installStartupService(options)).rejects.toThrow(/unrelated scheduled task/);
    expect(runner.mock.calls.some(([, arguments_]) => arguments_[0] === '/Create')).toBe(false);
  });

  it('retains exact pending ownership and repairs a task when its initial run is interrupted', async () => {
    const sourceNodePath = path.join(temporaryDirectory, 'node.exe');
    const sourceCliPath = path.join(temporaryDirectory, 'cli.js');
    const runtimeDirectory = path.join(temporaryDirectory, 'recoverable-runtime');
    vi.stubEnv('LOCALAPPDATA', runtimeDirectory);
    await writeFile(sourceNodePath, 'node');
    await writeFile(sourceCliPath, "console.log('service');\n");
    let taskExists = false;
    let failFirstRun = true;
    const runner = vi.fn(async (_command: string, arguments_: string[]) => {
      if (arguments_[0] === '/Query') {
        if (!taskExists) {
          throw new Error('Task does not exist.');
        }
        return {
          stdout: taskXml(
            '%LOCALAPPDATA%\\n.exe',
            '&quot;%LOCALAPPDATA%\\c.js&quot; proxy start --service --service-config &quot;%LOCALAPPDATA%\\s.json&quot;',
          ),
          stderr: '',
        };
      }
      if (arguments_[0] === '/Create') {
        taskExists = true;
      }
      if (arguments_[0] === '/Run' && failFirstRun) {
        failFirstRun = false;
        throw new Error('Task launch was interrupted.');
      }
      return { stdout: '', stderr: '' };
    });
    const options = {
      platform: 'win32' as const,
      namespace: 'default',
      paths: statePaths(),
      nodePath: sourceNodePath,
      cliPath: sourceCliPath,
      runtimeInstallDirectory: runtimeDirectory,
      runner,
    };

    await expect(installStartupService(options)).rejects.toThrow(/interrupted/);
    await expect(
      readFile(path.join(options.paths.stateDirectory, 'service-install-v2.json'), 'utf8'),
    ).resolves.toContain('"installationState": "installing"');

    await expect(installStartupService(options)).resolves.toMatchObject({
      record: { version: 2, installationState: 'installed' },
    });
    const endIndex = runner.mock.calls.findIndex(([, arguments_]) => arguments_[0] === '/End');
    let secondCreateIndex = -1;
    for (const [index, [, arguments_]] of runner.mock.calls.entries()) {
      if (arguments_[0] === '/Create') {
        secondCreateIndex = index;
      }
    }
    expect(endIndex).toBeGreaterThan(-1);
    expect(secondCreateIndex).toBeGreaterThan(endIndex);
  });

  it('revalidates a recorded Windows task before updating its durable runtime', async () => {
    const sourceNodePath = path.join(temporaryDirectory, 'node.exe');
    const sourceCliPath = path.join(temporaryDirectory, 'cli.js');
    const runtimeDirectory = path.join(temporaryDirectory, 'owned-runtime');
    vi.stubEnv('LOCALAPPDATA', runtimeDirectory);
    await writeFile(sourceNodePath, 'node');
    await writeFile(sourceCliPath, "console.log('service');\n");
    let taskExists = false;
    let taskOwned = true;
    let extraAction = false;
    const runner = vi.fn(async (_command: string, arguments_: string[]) => {
      if (arguments_[0] === '/Query') {
        if (!taskExists) {
          throw new Error('Task does not exist.');
        }
        return {
          stdout: taskOwned
            ? taskXml(
                '%LOCALAPPDATA%\\n.exe',
                '&quot;%LOCALAPPDATA%\\c.js&quot; proxy start --service --service-config &quot;%LOCALAPPDATA%\\s.json&quot;',
                extraAction
                  ? '<ComHandler><ClassId>{00000000-0000-0000-0000-000000000000}</ClassId></ComHandler>'
                  : '',
              )
            : `<Task><Description>%LOCALAPPDATA%\\n.exe &quot;%LOCALAPPDATA%\\c.js&quot; proxy start --service --service-config &quot;%LOCALAPPDATA%\\s.json&quot;</Description><Actions><Exec><Command>C:\\unrelated.exe</Command><Arguments>--unrelated</Arguments></Exec></Actions></Task>`,
          stderr: '',
        };
      }
      if (arguments_[0] === '/Create') {
        taskExists = true;
      }
      return { stdout: '', stderr: '' };
    });
    const options = {
      platform: 'win32' as const,
      namespace: 'default',
      paths: statePaths(),
      nodePath: sourceNodePath,
      cliPath: sourceCliPath,
      runtimeInstallDirectory: runtimeDirectory,
      runner,
    };
    await installStartupService(options);
    extraAction = true;
    runner.mockClear();

    await expect(installStartupService(options)).rejects.toThrow(/unrelated scheduled task/);
    expect(runner.mock.calls.some(([, arguments_]) => arguments_[0] === '/End')).toBe(false);
    expect(runner.mock.calls.some(([, arguments_]) => arguments_[0] === '/Create')).toBe(false);

    extraAction = false;
    taskOwned = false;
    runner.mockClear();

    await expect(installStartupService(options)).rejects.toThrow(/unrelated scheduled task/);
    expect(runner.mock.calls.some(([, arguments_]) => arguments_[0] === '/End')).toBe(false);
    expect(runner.mock.calls.some(([, arguments_]) => arguments_[0] === '/Create')).toBe(false);
  });

  it('keeps every owned legacy task recoverable until the canonical task is ready', async () => {
    const sourceNodePath = path.join(temporaryDirectory, 'node.exe');
    const sourceCliPath = path.join(temporaryDirectory, 'cli.js');
    const canonicalRuntime = path.join(temporaryDirectory, 'canonical-runtime');
    const legacyRuntime = path.join(temporaryDirectory, 'legacy-runtime');
    vi.stubEnv('LOCALAPPDATA', canonicalRuntime);
    const legacyPaths = {
      ...statePaths(),
      stateDirectory: path.join(temporaryDirectory, 'legacy-state'),
      socketPath: 'vite-local-tls-legacy-pipe',
    };
    const legacyRecord = {
      version: 1 as const,
      platform: 'win32' as const,
      namespace: 'playground',
      identifier: 'Vite Local TLS\\playground',
      definitionPath: null,
      nodePath: path.join(legacyRuntime, 'n.exe'),
      cliPath: path.join(legacyRuntime, 'c.js'),
      runtimeDirectory: legacyRuntime,
      controlSocket: null,
      installedAt: '2026-08-28T00:00:00.000Z',
    };
    const legacyConfigurationPath = path.join(legacyRuntime, 's.json');
    await Promise.all([
      writeFile(sourceNodePath, 'node'),
      writeFile(sourceCliPath, "console.log('service');\n"),
      mkdir(legacyRuntime, { recursive: true }),
      mkdir(legacyPaths.stateDirectory, { recursive: true }),
    ]);
    await writeFile(
      path.join(legacyPaths.stateDirectory, 'service-install.json'),
      `${JSON.stringify(legacyRecord)}\n`,
    );
    await writeFile(
      legacyConfigurationPath,
      `${JSON.stringify({
        version: 1,
        owner: '@vampaz/vite-plugin-local-tls',
        namespace: 'playground',
        controlSocket: null,
      })}\n`,
    );
    const tasks = new Map([
      [
        legacyRecord.identifier,
        taskXml(
          legacyRecord.nodePath,
          `&quot;${legacyRecord.cliPath}&quot; proxy start --service --service-config &quot;${legacyConfigurationPath}&quot;`,
        ),
      ],
    ]);
    let failCanonicalCreate = true;
    let failCanonicalRun = false;
    const runner = vi.fn(async (_command: string, arguments_: string[]) => {
      const identifier = arguments_[arguments_.indexOf('/TN') + 1]!;
      if (arguments_[0] === '/Query') {
        const task = tasks.get(identifier);
        if (!task) {
          throw new Error('Task does not exist.');
        }
        return { stdout: task, stderr: '' };
      }
      if (arguments_[0] === '/Delete') {
        tasks.delete(identifier);
      }
      if (arguments_[0] === '/Create') {
        if (failCanonicalCreate && identifier === 'Vite Local TLS\\default') {
          throw new Error('Canonical task creation failed.');
        }
        tasks.set(
          identifier,
          taskXml(
            '%LOCALAPPDATA%\\n.exe',
            '&quot;%LOCALAPPDATA%\\c.js&quot; proxy start --service --service-config &quot;%LOCALAPPDATA%\\s.json&quot;',
          ),
        );
      }
      if (
        arguments_[0] === '/Run' &&
        identifier === 'Vite Local TLS\\default' &&
        failCanonicalRun
      ) {
        throw new Error('Canonical task did not become ready.');
      }
      return { stdout: '', stderr: '' };
    });
    const canonicalOptions = {
      platform: 'win32' as const,
      namespace: 'default',
      paths: statePaths(),
      nodePath: sourceNodePath,
      cliPath: sourceCliPath,
      runtimeInstallDirectory: canonicalRuntime,
      runner,
    };

    const obsoleteOptions = {
      ...canonicalOptions,
      namespace: 'playground',
      paths: legacyPaths,
      runtimeInstallDirectory: legacyRuntime,
    };
    vi.spyOn(LocalTlsService.prototype, 'stopIfIdle').mockResolvedValue(true);

    await expect(replaceStartupService(canonicalOptions, [obsoleteOptions])).rejects.toThrow(
      /Canonical task creation failed/,
    );
    expect(tasks.has(legacyRecord.identifier)).toBe(true);
    expect(runner).toHaveBeenCalledWith('schtasks.exe', [
      '/Change',
      '/TN',
      legacyRecord.identifier,
      '/Enable',
    ]);
    await expect(
      access(path.join(legacyPaths.stateDirectory, 'service-install.json')),
    ).resolves.toBeUndefined();
    await expect(access(legacyRuntime)).resolves.toBeUndefined();

    failCanonicalCreate = false;
    failCanonicalRun = true;
    runner.mockClear();
    await expect(replaceStartupService(canonicalOptions, [obsoleteOptions])).rejects.toThrow(
      /did not become ready/,
    );
    expect(tasks.has(legacyRecord.identifier)).toBe(true);
    expect(tasks.has('Vite Local TLS\\default')).toBe(false);
    expect(runner).toHaveBeenCalledWith('schtasks.exe', [
      '/Change',
      '/TN',
      legacyRecord.identifier,
      '/Enable',
    ]);

    failCanonicalRun = false;
    runner.mockClear();
    await replaceStartupService(canonicalOptions, [obsoleteOptions]);

    const deleteIndex = runner.mock.calls.findIndex(
      ([, arguments_]) =>
        arguments_[0] === '/Delete' && arguments_.includes(legacyRecord.identifier),
    );
    const createIndex = runner.mock.calls.findIndex(
      ([, arguments_]) =>
        arguments_[0] === '/Create' && arguments_.includes('Vite Local TLS\\default'),
    );
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(createIndex);
    expect(tasks.has(legacyRecord.identifier)).toBe(false);
    expect(tasks.has('Vite Local TLS\\default')).toBe(true);
    await expect(
      access(path.join(legacyPaths.stateDirectory, 'service-install.json')),
    ).rejects.toThrow();
    await expect(access(legacyRuntime)).rejects.toThrow();
  });

  it('restores legacy tasks when an already-installed canonical task fails to start', async () => {
    const sourceNodePath = path.join(temporaryDirectory, 'node.exe');
    const sourceCliPath = path.join(temporaryDirectory, 'cli.js');
    const canonicalRuntime = path.join(temporaryDirectory, 'canonical-runtime');
    const legacyRuntime = path.join(temporaryDirectory, 'legacy-runtime');
    vi.stubEnv('LOCALAPPDATA', canonicalRuntime);
    await Promise.all([
      writeFile(sourceNodePath, 'node'),
      writeFile(sourceCliPath, "console.log('service');\n"),
      mkdir(legacyRuntime, { recursive: true }),
    ]);
    const tasks = new Map<string, string>();
    const enabled = new Map<string, boolean>();
    let failCanonicalRun = false;
    const runner = vi.fn(async (_command: string, arguments_: string[]) => {
      const identifier = arguments_[arguments_.indexOf('/TN') + 1]!;
      if (arguments_[0] === '/Query') {
        const task = tasks.get(identifier);
        if (!task) {
          throw new Error('Task does not exist.');
        }
        return { stdout: task, stderr: '' };
      }
      if (arguments_[0] === '/Create') {
        tasks.set(
          identifier,
          taskXml(
            '%LOCALAPPDATA%\\n.exe',
            '&quot;%LOCALAPPDATA%\\c.js&quot; proxy start --service --service-config &quot;%LOCALAPPDATA%\\s.json&quot;',
          ),
        );
        enabled.set(identifier, true);
      }
      if (arguments_[0] === '/Change') {
        enabled.set(identifier, arguments_.includes('/Enable'));
      }
      if (arguments_[0] === '/Run' && identifier === 'Vite Local TLS\\default') {
        if (failCanonicalRun) {
          throw new Error('Canonical task start failed.');
        }
      }
      if (arguments_[0] === '/Delete') {
        tasks.delete(identifier);
        enabled.delete(identifier);
      }
      return { stdout: '', stderr: '' };
    });
    const canonicalOptions = {
      platform: 'win32' as const,
      namespace: 'default',
      paths: statePaths(),
      nodePath: sourceNodePath,
      cliPath: sourceCliPath,
      runtimeInstallDirectory: canonicalRuntime,
      runner,
    };
    await installStartupService(canonicalOptions);

    const legacyPaths = {
      ...statePaths(),
      stateDirectory: path.join(temporaryDirectory, 'legacy-state'),
      socketPath: 'vite-local-tls-legacy-pipe',
    };
    const legacyRecord = {
      version: 1 as const,
      platform: 'win32' as const,
      namespace: 'playground',
      identifier: 'Vite Local TLS\\playground',
      definitionPath: null,
      nodePath: path.join(legacyRuntime, 'n.exe'),
      cliPath: path.join(legacyRuntime, 'c.js'),
      runtimeDirectory: legacyRuntime,
      controlSocket: null,
      installedAt: '2026-08-28T00:00:00.000Z',
    };
    const legacyConfigurationPath = path.join(legacyRuntime, 's.json');
    await mkdir(legacyPaths.stateDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(legacyPaths.stateDirectory, 'service-install.json'),
        `${JSON.stringify(legacyRecord)}\n`,
      ),
      writeFile(
        legacyConfigurationPath,
        `${JSON.stringify({
          version: 1,
          owner: '@vampaz/vite-plugin-local-tls',
          namespace: 'playground',
          controlSocket: null,
        })}\n`,
      ),
    ]);
    tasks.set(
      legacyRecord.identifier,
      taskXml(
        legacyRecord.nodePath,
        `&quot;${legacyRecord.cliPath}&quot; proxy start --service --service-config &quot;${legacyConfigurationPath}&quot;`,
      ),
    );
    enabled.set(legacyRecord.identifier, true);
    const legacyOptions = {
      ...canonicalOptions,
      namespace: 'playground',
      paths: legacyPaths,
      runtimeInstallDirectory: legacyRuntime,
    };
    vi.spyOn(LocalTlsService.prototype, 'stopIfIdle')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);

    failCanonicalRun = true;
    await expect(startStartupService(canonicalOptions, [legacyOptions])).rejects.toThrow(
      /start failed/,
    );
    expect(tasks.has(legacyRecord.identifier)).toBe(true);
    expect(enabled.get(legacyRecord.identifier)).toBe(true);
    expect(enabled.get('Vite Local TLS\\default')).toBe(false);

    failCanonicalRun = false;
    await startStartupService(canonicalOptions, [legacyOptions]);
    expect(tasks.has(legacyRecord.identifier)).toBe(false);
    expect(enabled.get('Vite Local TLS\\default')).toBe(true);
  });

  it('restores the previously healthy Windows owner when canonical replacement fails', async () => {
    const sourceNodePath = path.join(temporaryDirectory, 'node.exe');
    const sourceCliPath = path.join(temporaryDirectory, 'cli.js');
    const canonicalRuntime = path.join(temporaryDirectory, 'canonical-runtime');
    const legacyRuntime = path.join(temporaryDirectory, 'legacy-runtime');
    vi.stubEnv('LOCALAPPDATA', canonicalRuntime);
    await Promise.all([
      writeFile(sourceNodePath, 'node'),
      writeFile(sourceCliPath, "console.log('old');\n"),
      mkdir(legacyRuntime, { recursive: true }),
    ]);
    const tasks = new Map<string, string>();
    const enabled = new Map<string, boolean>();
    let failNextCanonicalRun = false;
    const runner = vi.fn(async (_command: string, arguments_: string[]) => {
      const identifier = arguments_[arguments_.indexOf('/TN') + 1]!;
      if (arguments_[0] === '/Query') {
        const task = tasks.get(identifier);
        if (!task) {
          throw new Error('Task does not exist.');
        }
        return { stdout: task, stderr: '' };
      }
      if (arguments_[0] === '/Create') {
        tasks.set(
          identifier,
          taskXml(
            '%LOCALAPPDATA%\\n.exe',
            '&quot;%LOCALAPPDATA%\\c.js&quot; proxy start --service --service-config &quot;%LOCALAPPDATA%\\s.json&quot;',
          ),
        );
        enabled.set(identifier, true);
      }
      if (arguments_[0] === '/Change') {
        enabled.set(identifier, arguments_.includes('/Enable'));
      }
      if (
        arguments_[0] === '/Run' &&
        identifier === 'Vite Local TLS\\default' &&
        failNextCanonicalRun
      ) {
        failNextCanonicalRun = false;
        throw new Error('Canonical replacement failed to start.');
      }
      if (arguments_[0] === '/Delete') {
        tasks.delete(identifier);
        enabled.delete(identifier);
      }
      return { stdout: '', stderr: '' };
    });
    const canonicalOptions = {
      platform: 'win32' as const,
      namespace: 'default',
      paths: statePaths(),
      nodePath: sourceNodePath,
      cliPath: sourceCliPath,
      currentVersion: '1.0.0',
      runtimeInstallDirectory: canonicalRuntime,
      runner,
    };
    await installStartupService(canonicalOptions);

    const legacyPaths = {
      ...statePaths(),
      stateDirectory: path.join(temporaryDirectory, 'legacy-state'),
      socketPath: 'vite-local-tls-legacy-pipe',
    };
    const legacyRecord = {
      version: 1 as const,
      platform: 'win32' as const,
      namespace: 'playground',
      identifier: 'Vite Local TLS\\playground',
      definitionPath: null,
      nodePath: path.join(legacyRuntime, 'n.exe'),
      cliPath: path.join(legacyRuntime, 'c.js'),
      runtimeDirectory: legacyRuntime,
      controlSocket: null,
      installedAt: '2026-08-28T00:00:00.000Z',
    };
    const legacyConfigurationPath = path.join(legacyRuntime, 's.json');
    await mkdir(legacyPaths.stateDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(legacyPaths.stateDirectory, 'service-install.json'),
        `${JSON.stringify(legacyRecord)}\n`,
      ),
      writeFile(
        legacyConfigurationPath,
        `${JSON.stringify({
          version: 1,
          owner: '@vampaz/vite-plugin-local-tls',
          namespace: 'playground',
          controlSocket: null,
        })}\n`,
      ),
    ]);
    tasks.set(
      legacyRecord.identifier,
      taskXml(
        legacyRecord.nodePath,
        `&quot;${legacyRecord.cliPath}&quot; proxy start --service --service-config &quot;${legacyConfigurationPath}&quot;`,
      ),
    );
    enabled.set(legacyRecord.identifier, true);
    const legacyOptions = {
      ...canonicalOptions,
      namespace: 'playground',
      paths: legacyPaths,
      runtimeInstallDirectory: legacyRuntime,
    };
    vi.spyOn(LocalTlsService.prototype, 'stopIfIdle').mockResolvedValue(true);
    const status = vi.spyOn(LocalTlsService.prototype, 'status').mockResolvedValue({
      running: true,
      activeRoutes: 0,
      protocolVersion: 1,
      compatible: true,
      state: null,
    });
    await writeFile(sourceCliPath, "console.log('new');\n");
    failNextCanonicalRun = true;

    await expect(
      replaceStartupService({ ...canonicalOptions, currentVersion: '2.0.0' }, [legacyOptions]),
    ).rejects.toThrow(/failed to start/);

    expect(tasks.has('Vite Local TLS\\default')).toBe(true);
    expect(enabled.get('Vite Local TLS\\default')).toBe(true);
    expect(enabled.get(legacyRecord.identifier)).toBe(false);
    expect(
      runner.mock.calls.some(
        ([, arguments_]) =>
          arguments_[0] === '/Delete' && arguments_.includes('Vite Local TLS\\default'),
      ),
    ).toBe(false);
    await expect(
      readFile(path.join(canonicalOptions.paths.stateDirectory, 'service-install-v2.json'), 'utf8'),
    ).resolves.toContain('"packageVersion": "1.0.0"');

    status.mockResolvedValue({
      running: false,
      activeRoutes: 0,
      protocolVersion: null,
      compatible: false,
      state: null,
    });
    failNextCanonicalRun = true;
    runner.mockClear();

    await expect(
      replaceStartupService({ ...canonicalOptions, currentVersion: '2.0.0' }, [legacyOptions]),
    ).rejects.toThrow(/failed to start/);

    expect(enabled.get('Vite Local TLS\\default')).toBe(false);
    expect(enabled.get(legacyRecord.identifier)).toBe(true);
    const disableCanonicalIndex = runner.mock.calls.findIndex(
      ([, arguments_]) =>
        arguments_[0] === '/Change' &&
        arguments_.includes('Vite Local TLS\\default') &&
        arguments_.includes('/Disable'),
    );
    const restoreLegacyIndex = runner.mock.calls.findIndex(
      ([, arguments_]) => arguments_[0] === '/Run' && arguments_.includes(legacyRecord.identifier),
    );
    expect(disableCanonicalIndex).toBeGreaterThan(-1);
    expect(restoreLegacyIndex).toBeGreaterThan(disableCanonicalIndex);
  });
});
