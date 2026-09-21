import { lstat, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ServiceRuntimeConfiguration } from '../interfaces/service-runtime-configuration.js';
import type {
  ServiceInstallCommandRunner,
  ServiceInstallationRecord,
  ServiceInstallOptions,
} from '../interfaces/service-install-options.js';
import {
  expectedRuntimeDirectory,
  installUserRuntime,
  optionsForInstallationRecord,
  quiesceInstalledService,
  replaceRuntimeFile,
  safeServiceKey,
  serviceBackupKey,
  singleWindowsExecAction,
  singleXmlContainer,
  stageRegularFileBackup,
  waitForStartupServiceReady,
  windowsQuote,
  xmlWithoutComments,
} from './shared.js';

function windowsConfigurationPath(runtimeDirectory: string): string {
  return path.join(runtimeDirectory, 's.json');
}

function windowsTaskPath(filePath: string): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return filePath;
  }
  const relativePath = path.win32.relative(localAppData, filePath);
  if (relativePath.startsWith('..') || path.win32.isAbsolute(relativePath)) {
    return filePath;
  }
  return path.win32.join('%LOCALAPPDATA%', relativePath);
}

function windowsTaskCommand(nodePath: string, cliPath: string, configurationPath: string): string {
  return `${windowsQuote(windowsTaskPath(nodePath))} ${windowsTaskArguments(
    cliPath,
    configurationPath,
  )}`;
}

function windowsTaskArgumentsForPaths(cliPath: string, configurationPath: string): string {
  return [
    windowsQuote(cliPath),
    'proxy',
    'start',
    '--service',
    '--service-config',
    windowsQuote(configurationPath),
  ].join(' ');
}

function windowsTaskArguments(cliPath: string, configurationPath: string): string {
  return windowsTaskArgumentsForPaths(windowsTaskPath(cliPath), windowsTaskPath(configurationPath));
}

function windowsTaskPathCandidates(filePath: string): string[] {
  return [...new Set([windowsTaskPath(filePath), filePath])];
}

function windowsTaskArgumentCandidates(cliPath: string, configurationPath: string): string[] {
  return windowsTaskPathCandidates(cliPath).flatMap((taskCliPath) =>
    windowsTaskPathCandidates(configurationPath).map((taskConfigurationPath) =>
      windowsTaskArgumentsForPaths(taskCliPath, taskConfigurationPath),
    ),
  );
}

export async function windowsTaskExists(
  runner: ServiceInstallCommandRunner,
  identifier: string,
): Promise<boolean> {
  return runner('schtasks.exe', ['/Query', '/TN', identifier])
    .then(() => true)
    .catch(() => false);
}

export async function installWindows(
  options: ServiceInstallOptions,
  runner: ServiceInstallCommandRunner,
  identifier: string,
  plannedRecord: ServiceInstallationRecord,
  existingRecord: ServiceInstallationRecord | null,
): Promise<{ nodePath: string; cliPath: string; runtimeDirectory: string }> {
  const taskExists = await windowsTaskExists(runner, identifier);
  if (taskExists) {
    if (!existingRecord) {
      await assertOwnedWindowsStartupTask(runner, plannedRecord).catch(() => {
        throw new Error(`Refusing to replace unrelated scheduled task: ${identifier}`);
      });
    } else {
      await assertOwnedWindowsStartupTask(runner, existingRecord).catch(async () => {
        await assertOwnedWindowsStartupTask(runner, plannedRecord);
      });
    }
  }
  const plannedRuntimeDirectory = expectedRuntimeDirectory(
    options,
    'win32',
    safeServiceKey(options),
  );
  const backupKey = serviceBackupKey(options, existingRecord ?? plannedRecord);
  const previousNodePath = path.join(
    options.paths.stateDirectory,
    `${backupKey}.previous.node.tmp`,
  );
  const previousCliPath = path.join(options.paths.stateDirectory, `${backupKey}.previous.cli.tmp`);
  const previousConfigurationPath = path.join(
    options.paths.stateDirectory,
    `${backupKey}.previous.config.tmp`,
  );
  let runtime: Awaited<ReturnType<typeof installUserRuntime>> | null = null;
  let runtimeMutationStarted = false;
  let taskCreated = false;
  let wasRunning = false;
  try {
    if (existingRecord) {
      await Promise.all([
        stageRegularFileBackup(existingRecord.nodePath, previousNodePath),
        stageRegularFileBackup(existingRecord.cliPath, previousCliPath),
        stageRegularFileBackup(
          windowsConfigurationPath(existingRecord.runtimeDirectory!),
          previousConfigurationPath,
        ),
      ]);
    }
    wasRunning = await quiesceInstalledService(
      existingRecord ? optionsForInstallationRecord(options, existingRecord) : options,
    );
    if (taskExists) {
      await runner('schtasks.exe', ['/End', '/TN', identifier]).catch(() => undefined);
    }
    runtimeMutationStarted = true;
    runtime = await installUserRuntime(options, safeServiceKey(options));
    const configurationPath = windowsConfigurationPath(runtime.runtimeDirectory);
    const configuration: ServiceRuntimeConfiguration = {
      version: 1,
      owner: '@vampaz/vite-plugin-local-tls',
      namespace: options.namespace,
      controlSocket: options.controlSocket ?? null,
    };
    await writeFile(configurationPath, `${JSON.stringify(configuration, null, 2)}\n`, {
      mode: 0o600,
    });
    const command = windowsTaskCommand(runtime.nodePath, runtime.cliPath, configurationPath);
    if (command.length > 261) {
      throw new Error('Windows Task Scheduler command exceeds its 261-character limit.');
    }
    await runner('schtasks.exe', [
      '/Create',
      '/TN',
      identifier,
      '/TR',
      command,
      '/SC',
      'ONLOGON',
      '/RL',
      'LIMITED',
      ...(taskExists ? ['/F'] : []),
    ]);
    taskCreated = true;
    await runner('schtasks.exe', ['/Run', '/TN', identifier]);
    await waitForStartupServiceReady({
      ...options,
      nodePath: runtime.nodePath,
      cliPath: runtime.cliPath,
    });
    return runtime;
  } catch (error) {
    if (existingRecord && runtimeMutationStarted) {
      try {
        await Promise.all([
          replaceRuntimeFile(previousNodePath, existingRecord.nodePath, 'win32'),
          replaceRuntimeFile(previousCliPath, existingRecord.cliPath, 'win32'),
          replaceRuntimeFile(
            previousConfigurationPath,
            windowsConfigurationPath(existingRecord.runtimeDirectory!),
            'win32',
          ),
        ]);
        if (taskExists) {
          const previousCommand = windowsTaskCommand(
            existingRecord.nodePath,
            existingRecord.cliPath,
            windowsConfigurationPath(existingRecord.runtimeDirectory!),
          );
          await runner('schtasks.exe', [
            '/Create',
            '/TN',
            identifier,
            '/TR',
            previousCommand,
            '/SC',
            'ONLOGON',
            '/RL',
            'LIMITED',
            '/F',
          ]);
          if (wasRunning) {
            await runner('schtasks.exe', ['/Run', '/TN', identifier]);
          }
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'The canonical scheduled-task update failed and its previous runtime could not be restored safely.',
        );
      }
    }
    throw error;
  } finally {
    await Promise.all([
      unlink(previousNodePath).catch(() => undefined),
      unlink(previousCliPath).catch(() => undefined),
      unlink(previousConfigurationPath).catch(() => undefined),
    ]);
    if (!existingRecord && !taskExists && !taskCreated) {
      await rm(plannedRuntimeDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function assertOwnedWindowsStartupTask(
  runner: ServiceInstallCommandRunner,
  record: ServiceInstallationRecord,
): Promise<void> {
  const task = await runner('schtasks.exe', ['/Query', '/TN', record.identifier, '/XML']);
  const configurationPath = windowsConfigurationPath(record.runtimeDirectory!);
  const configurationDetails = await lstat(configurationPath);
  if (!configurationDetails.isFile() || configurationDetails.isSymbolicLink()) {
    throw new Error(`Refusing unsafe scheduled task configuration: ${configurationPath}`);
  }
  const configuration = JSON.parse(
    await readFile(configurationPath, 'utf8'),
  ) as ServiceRuntimeConfiguration;
  const ownsConfiguration =
    configuration.version === 1 &&
    configuration.owner === '@vampaz/vite-plugin-local-tls' &&
    configuration.namespace === record.namespace &&
    configuration.controlSocket === record.controlSocket;
  const taskPaths = windowsTaskPathCandidates(record.nodePath).flatMap((taskPath) => [
    taskPath,
    windowsQuote(taskPath),
  ]);
  const taskArguments = windowsTaskArgumentCandidates(record.cliPath, configurationPath);
  const taskXml = xmlWithoutComments(task.stdout);
  const actions = singleXmlContainer(taskXml, 'Actions');
  const action = actions ? singleWindowsExecAction(actions) : null;
  const ownsTask =
    ownsConfiguration &&
    action !== null &&
    taskPaths.includes(action.command) &&
    taskArguments.includes(action.arguments_);
  if (!ownsTask) {
    throw new Error(
      `Refusing to operate on unrelated scheduled task: ${record.identifier}. ` +
        `Owned configuration: ${String(ownsConfiguration)}; ` +
        `observed command: ${JSON.stringify(action?.command ?? null)}; ` +
        `observed arguments: ${JSON.stringify(action?.arguments_ ?? null)}; ` +
        `exact single action: ${String(action !== null)}.`,
    );
  }
}
