import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ServiceInstallCommandResult,
  ServiceInstallCommandRunner,
  ServiceInstallElevatedCommand,
  ServiceInstallationRecord,
  ServiceInstallOptions,
  ServiceInstallResult,
  StartupServiceUpdateStatus,
} from './interfaces/service-install-options.js';
import type { ServiceRuntimeConfiguration } from './interfaces/service-runtime-configuration.js';
import { executeCommand } from './command-runner.js';
import { CONTROL_PROTOCOL_VERSION } from './control-protocol.js';
import { PACKAGE_VERSION } from './package-version.js';
import { compareServiceVersions } from './service-version.js';
import { ensurePersistentStatePaths, ensureStatePaths } from './state-paths.js';
import type { MacosControlClient, ObsoleteServiceInstallation } from './service-install/shared.js';
import {
  CANONICAL_SERVICE_NAMESPACE,
  assertOwnedDefinition,
  expectedDefinitionPath,
  expectedRuntimeDirectory,
  inspectRunningInstallations,
  installUserRuntime,
  installedService,
  launchdDefinition,
  optionsForInstallationRecord,
  previousRecordPath,
  quiesceInstalledService,
  readPreviousRecord,
  readRecord,
  recordPath,
  removeInstallationRecords,
  replaceRuntimeFile,
  runElevatedCommand,
  runElevatedCommands,
  safeServiceKey,
  serviceBackupKey,
  serviceIdentifier,
  singleWindowsExecAction,
  singleXmlContainer,
  stageRegularFileBackup,
  systemdDefinition,
  waitForStartupServiceReady,
  windowsQuote,
  writePreviousRecord,
  writeRecord,
  xmlWithoutComments,
} from './service-install/shared.js';

export {
  CANONICAL_SERVICE_NAMESPACE,
  expectedDefinitionPath,
  expectedRuntimeDirectory,
  serviceDefinitionMatchesInstallation,
  serviceIdentifier,
  STARTUP_SERVICE_OWNER_MARKER,
} from './service-install/shared.js';

const MACOS_LAUNCHD_REMOVAL_WAIT_SOURCE = [
  'import { spawnSync } from "node:child_process";',
  'const identifier = process.argv[1];',
  'const deadline = Date.now() + 10_000;',
  'let absentChecks = 0;',
  'while (Date.now() < deadline) {',
  '  const child = spawnSync("launchctl", ["print", `system/${identifier}`], { stdio: "ignore" });',
  '  if (child.error) { console.error(child.error.message); process.exit(1); }',
  '  absentChecks = child.status === 0 ? 0 : absentChecks + 1;',
  '  if (absentChecks === 2) process.exit(0);',
  '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);',
  '}',
  'console.error(`Timed out waiting for launchd to remove ${identifier}.`);',
  'process.exit(1);',
].join('\n');

const MACOS_SERVICE_READINESS_WAIT_SOURCE = [
  'import { spawnSync } from "node:child_process";',
  'const [nodePath, cliPath, namespace, controlSocket] = process.argv.slice(1);',
  'const deadline = Date.now() + 30_000;',
  'let lastStatus = "no status response";',
  'while (Date.now() < deadline) {',
  '  const child = spawnSync(nodePath, [cliPath, "proxy", "status", "--namespace", namespace, "--control-socket", controlSocket], { encoding: "utf8", timeout: 2_000 });',
  '  lastStatus = child.error?.message || child.stderr?.trim() || child.stdout?.trim() || `exit ${child.status}`;',
  '  if (!child.error && child.status === 0) {',
  '    try {',
  '      const status = JSON.parse(child.stdout);',
  '      if (status.running === true && status.compatible === true) process.exit(0);',
  '    } catch {}',
  '  }',
  '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);',
  '}',
  'console.error(`Timed out waiting for the installed local TLS service: ${lastStatus}`);',
  'process.exit(1);',
].join('\n');

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

export async function getStartupServiceUpdateStatus(
  options: ServiceInstallOptions,
): Promise<StartupServiceUpdateStatus> {
  const record = await readRecord(options);
  if (!record) {
    return 'absent';
  }
  if (record.version === 1) {
    return 'legacy';
  }
  if (record.installationState !== 'installed') {
    return 'installing';
  }
  const versionComparison = compareServiceVersions(
    record.packageVersion,
    options.currentVersion ?? PACKAGE_VERSION,
  );
  if (versionComparison === null) {
    return 'modified';
  }
  if (versionComparison === 1) {
    return record.protocolVersion === CONTROL_PROTOCOL_VERSION ? 'newer' : 'newer-incompatible';
  }
  if (versionComparison === -1) {
    return 'outdated';
  }
  if (record.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
    return 'modified';
  }
  if (record.controlSocket !== (options.controlSocket ?? null)) {
    return 'modified';
  }
  try {
    const [currentCli, installedCli] = await Promise.all([
      readFile(options.cliPath),
      readFile(record.cliPath),
    ]);
    return currentCli.equals(installedCli) ? 'current' : 'modified';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'modified';
    }
    throw error;
  }
}

export async function isStartupServiceCurrent(options: ServiceInstallOptions): Promise<boolean> {
  return ['absent', 'current', 'newer'].includes(await getStartupServiceUpdateStatus(options));
}

function macosBootoutCommands(
  installations: ObsoleteServiceInstallation[],
  clearRollbackAfterLast = false,
): ServiceInstallElevatedCommand[] {
  return installations.flatMap(({ record }, index) => [
    {
      command: 'launchctl',
      arguments_: ['bootout', `system/${record.identifier}`],
      allowFailure: true,
    },
    {
      command: process.execPath,
      arguments_: [
        '--input-type=module',
        '--eval',
        MACOS_LAUNCHD_REMOVAL_WAIT_SOURCE,
        record.identifier,
      ],
      clearRollbackAfterSuccess: clearRollbackAfterLast && index === installations.length - 1,
    },
  ]);
}

function macosCleanupCommands(
  installations: ObsoleteServiceInstallation[],
): ServiceInstallElevatedCommand[] {
  return installations.flatMap(({ installation, record }) => [
    {
      command: 'rm',
      arguments_: ['-f', record.definitionPath!],
      clearRollbackAfterSuccess: true,
    },
    {
      command: 'rm',
      arguments_: [
        '-f',
        recordPath(installation, 1),
        recordPath(installation, 2),
        previousRecordPath(installation),
      ],
    },
    ...(record.runtimeDirectory
      ? [{ command: 'rm', arguments_: ['-rf', record.runtimeDirectory] }]
      : []),
  ]);
}

function macosQuiesceCommands(
  installations: ObsoleteServiceInstallation[],
  restoreStoppedInstallations = false,
  controlClient?: MacosControlClient,
): ServiceInstallElevatedCommand[] {
  return installations.flatMap(({ installation, record, wasRunning }) => [
    {
      command: 'launchctl',
      arguments_: ['disable', `system/${record.identifier}`],
      rollbackAfterSuccess: [
        {
          command: 'launchctl',
          arguments_: ['enable', `system/${record.identifier}`],
        },
      ],
    },
    {
      command: controlClient?.nodePath ?? installation.nodePath,
      arguments_: [
        controlClient?.cliPath ?? installation.cliPath,
        'proxy',
        'stop',
        '--namespace',
        record.namespace,
        '--control-socket',
        installation.paths.socketPath,
      ],
      ...(wasRunning === false && !restoreStoppedInstallations
        ? { discardRollbackAfterSuccess: true }
        : {}),
      ...(wasRunning === false
        ? {}
        : {
            rollbackAfterSuccess: [
              {
                command: 'launchctl',
                arguments_: ['enable', `system/${record.identifier}`],
              },
              {
                command: 'launchctl',
                arguments_: ['bootstrap', 'system', record.definitionPath!],
                allowFailure: true,
              },
              {
                command: 'launchctl',
                arguments_: ['kickstart', `system/${record.identifier}`],
              },
            ],
          }),
    },
  ]);
}

async function stageMacosControlClient(
  options: ServiceInstallOptions,
): Promise<MacosControlClient> {
  const cliPath = path.join(
    options.paths.stateDirectory,
    `.service-control-${process.pid}-${randomUUID()}.js`,
  );
  await copyFile(options.readinessCliPath ?? options.cliPath, cliPath);
  await chmod(cliPath, 0o600);
  return { nodePath: process.execPath, cliPath };
}

function macosReadinessCommand(
  nodePath: string,
  cliPath: string,
  namespace: string,
  controlSocket: string,
): ServiceInstallElevatedCommand {
  return {
    command: process.execPath,
    arguments_: [
      '--input-type=module',
      '--eval',
      MACOS_SERVICE_READINESS_WAIT_SOURCE,
      nodePath,
      cliPath,
      namespace,
      controlSocket,
    ],
    clearRollbackAfterSuccess: true,
    timeoutMs: 35_000,
  };
}

async function installMacos(
  options: ServiceInstallOptions,
  runner: ServiceInstallCommandRunner,
  identifier: string,
  plannedRecord: ServiceInstallationRecord,
  existingRecord: ServiceInstallationRecord | null,
  obsoleteInstallations: ObsoleteServiceInstallation[] = [],
): Promise<{
  definitionPath: string;
  nodePath: string;
  cliPath: string;
  runtimeDirectory: string;
}> {
  const definitionPath = path.join(
    options.definitionDirectory ?? '/Library/LaunchDaemons',
    `${identifier}.plist`,
  );
  const runtimeDirectory = expectedRuntimeDirectory(options, 'darwin', safeServiceKey(options));
  const nodePath = path.join(runtimeDirectory, 'node');
  const cliPath = path.join(runtimeDirectory, 'cli.js');
  const temporaryDefinitionPath = path.join(
    options.paths.stateDirectory,
    `${identifier}.plist.tmp`,
  );
  const temporaryCliPath = path.join(options.paths.stateDirectory, `${identifier}.cli.js.tmp`);
  const temporaryReadinessCliPath = path.join(
    options.paths.stateDirectory,
    `${identifier}.readiness-cli.tmp.js`,
  );
  const temporaryInstalledRecordPath = path.join(
    options.paths.stateDirectory,
    `${identifier}.service-install-v2.json.tmp`,
  );
  const backupKey = serviceBackupKey(options, existingRecord ?? plannedRecord);
  const previousDefinitionPath = path.join(
    options.paths.stateDirectory,
    `${backupKey}.previous.plist.tmp`,
  );
  const previousNodePath = path.join(
    options.paths.stateDirectory,
    `${backupKey}.previous.node.tmp`,
  );
  const previousCliPath = path.join(
    options.paths.stateDirectory,
    `${backupKey}.previous.cli.js.tmp`,
  );
  await assertOwnedDefinition(
    definitionPath,
    existingRecord
      ? [
          {
            options: optionsForInstallationRecord(options, existingRecord),
            record: existingRecord,
          },
          { options, record: plannedRecord },
        ]
      : { options, record: plannedRecord },
  );
  for (const { installation, record } of obsoleteInstallations) {
    await assertOwnedDefinition(record.definitionPath!, { options: installation, record }, true);
  }
  try {
    const trackedExisting = existingRecord
      ? (
          await inspectRunningInstallations([
            {
              installation: optionsForInstallationRecord(options, existingRecord),
              record: existingRecord,
            },
          ])
        )[0]!
      : null;
    const trackedObsolete = await inspectRunningInstallations(obsoleteInstallations);
    const rollbackWinnerIdentifier =
      (trackedExisting?.wasRunning ? trackedExisting.record.identifier : null) ??
      trackedObsolete.find(({ wasRunning }) => wasRunning)?.record.identifier ??
      null;
    const rollbackExisting = trackedExisting
      ? {
          ...trackedExisting,
          wasRunning: trackedExisting.record.identifier === rollbackWinnerIdentifier,
        }
      : null;
    const rollbackObsolete = trackedObsolete.map((installation) => ({
      ...installation,
      wasRunning: installation.record.identifier === rollbackWinnerIdentifier,
    }));
    if (!existingRecord) {
      await quiesceInstalledService(options);
    } else {
      await Promise.all([
        stageRegularFileBackup(definitionPath, previousDefinitionPath),
        stageRegularFileBackup(existingRecord.nodePath, previousNodePath),
        stageRegularFileBackup(existingRecord.cliPath, previousCliPath),
      ]);
    }
    await writeFile(
      temporaryDefinitionPath,
      launchdDefinition({ ...options, nodePath, cliPath }, identifier),
      { mode: 0o600 },
    );
    if (plannedRecord.version !== 2) {
      throw new Error('The planned canonical service record must use version 2.');
    }
    await writeFile(
      temporaryInstalledRecordPath,
      `${JSON.stringify({ ...plannedRecord, installationState: 'installed' }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await copyFile(options.cliPath, temporaryCliPath);
    await copyFile(options.readinessCliPath ?? options.cliPath, temporaryReadinessCliPath);
    await runElevatedCommands(options, runner, [
      ...(existingRecord
        ? macosQuiesceCommands([rollbackExisting!], rollbackWinnerIdentifier === null, {
            nodePath: process.execPath,
            cliPath: temporaryReadinessCliPath,
          })
        : []),
      ...macosQuiesceCommands(rollbackObsolete, false, {
        nodePath: process.execPath,
        cliPath: temporaryReadinessCliPath,
      }),
      ...(existingRecord
        ? [
            {
              command: 'test',
              arguments_: ['-f', previousDefinitionPath],
              rollbackAfterSuccess: [
                {
                  command: 'launchctl',
                  arguments_: ['bootout', `system/${identifier}`],
                  allowFailure: true,
                },
                {
                  command: process.execPath,
                  arguments_: [
                    '--input-type=module',
                    '--eval',
                    MACOS_LAUNCHD_REMOVAL_WAIT_SOURCE,
                    identifier,
                  ],
                },
                {
                  command: 'install',
                  arguments_: ['-m', '0755', previousNodePath, nodePath],
                },
                {
                  command: 'install',
                  arguments_: ['-m', '0644', previousCliPath, cliPath],
                },
                {
                  command: 'install',
                  arguments_: ['-m', '0644', previousDefinitionPath, definitionPath],
                },
              ],
            },
          ]
        : []),
      ...macosBootoutCommands(trackedObsolete),
      { command: 'mkdir', arguments_: ['-p', runtimeDirectory] },
      { command: 'install', arguments_: ['-m', '0755', options.nodePath, nodePath] },
      { command: 'install', arguments_: ['-m', '0644', temporaryCliPath, cliPath] },
      {
        command: 'install',
        arguments_: ['-m', '0644', temporaryDefinitionPath, definitionPath],
      },
      {
        command: 'launchctl',
        arguments_: ['bootout', `system/${identifier}`],
        allowFailure: true,
      },
      {
        command: process.execPath,
        arguments_: [
          '--input-type=module',
          '--eval',
          MACOS_LAUNCHD_REMOVAL_WAIT_SOURCE,
          identifier,
        ],
      },
      { command: 'launchctl', arguments_: ['enable', `system/${identifier}`] },
      {
        command: 'launchctl',
        arguments_: ['bootstrap', 'system', definitionPath],
        ...(!existingRecord
          ? {
              rollbackAfterSuccess: [
                {
                  command: 'launchctl',
                  arguments_: ['bootout', `system/${identifier}`],
                  allowFailure: true,
                },
                {
                  command: process.execPath,
                  arguments_: [
                    '--input-type=module',
                    '--eval',
                    MACOS_LAUNCHD_REMOVAL_WAIT_SOURCE,
                    identifier,
                  ],
                },
                { command: 'rm', arguments_: ['-f', definitionPath] },
                { command: 'rm', arguments_: ['-rf', runtimeDirectory] },
              ],
            }
          : {}),
      },
      {
        command: 'launchctl',
        arguments_: ['kickstart', '-k', `system/${identifier}`],
      },
      macosReadinessCommand(
        process.execPath,
        temporaryReadinessCliPath,
        options.namespace,
        options.paths.socketPath,
      ),
      {
        command: 'mv',
        arguments_: ['-f', temporaryInstalledRecordPath, recordPath(options, 2)],
      },
      ...macosCleanupCommands(trackedObsolete),
    ]);
  } finally {
    await Promise.all([
      unlink(temporaryDefinitionPath).catch(() => undefined),
      unlink(temporaryCliPath).catch(() => undefined),
      unlink(temporaryReadinessCliPath).catch(() => undefined),
      unlink(temporaryInstalledRecordPath).catch(() => undefined),
      unlink(previousDefinitionPath).catch(() => undefined),
      unlink(previousNodePath).catch(() => undefined),
      unlink(previousCliPath).catch(() => undefined),
    ]);
  }
  return { definitionPath, nodePath, cliPath, runtimeDirectory };
}

async function installLinux(
  options: ServiceInstallOptions,
  runner: ServiceInstallCommandRunner,
  identifier: string,
  plannedRecord: ServiceInstallationRecord,
  existingRecord: ServiceInstallationRecord | null,
  obsoleteInstallations: ObsoleteServiceInstallation[] = [],
): Promise<{
  definitionPath: string;
  nodePath: string;
  cliPath: string;
  runtimeDirectory: string;
}> {
  const definitionPath = path.join(
    options.definitionDirectory ?? '/etc/systemd/system',
    `${identifier}.service`,
  );
  await assertOwnedDefinition(
    definitionPath,
    existingRecord
      ? [
          {
            options: optionsForInstallationRecord(options, existingRecord),
            record: existingRecord,
          },
          { options, record: plannedRecord },
        ]
      : { options, record: plannedRecord },
  );
  for (const { installation, record } of obsoleteInstallations) {
    await assertOwnedDefinition(record.definitionPath!, { options: installation, record }, true);
  }
  const temporaryPath = path.join(options.paths.stateDirectory, `${identifier}.service.tmp`);
  const backupKey = serviceBackupKey(options, existingRecord ?? plannedRecord);
  const previousDefinitionPath = path.join(
    options.paths.stateDirectory,
    `${backupKey}.previous.service.tmp`,
  );
  const previousNodePath = path.join(
    options.paths.stateDirectory,
    `${backupKey}.previous.node.tmp`,
  );
  const previousCliPath = path.join(
    options.paths.stateDirectory,
    `${backupKey}.previous.cli.js.tmp`,
  );
  async function runElevated(
    command: string,
    arguments_: string[],
  ): Promise<ServiceInstallCommandResult> {
    return runElevatedCommand(options, runner, command, arguments_);
  }
  const disabledInstallations: ObsoleteServiceInstallation[] = [];
  const stoppedIdentifiers = new Set<string>();
  let runtime: Awaited<ReturnType<typeof installUserRuntime>> | null = null;
  let canonicalMutationStarted = false;
  let canonicalStarted = false;
  try {
    if (existingRecord) {
      await Promise.all([
        stageRegularFileBackup(definitionPath, previousDefinitionPath),
        stageRegularFileBackup(existingRecord.nodePath, previousNodePath),
        stageRegularFileBackup(existingRecord.cliPath, previousCliPath),
      ]);
    }
    const canonicalOptions = existingRecord
      ? optionsForInstallationRecord(options, existingRecord)
      : options;
    if (await quiesceInstalledService(canonicalOptions)) {
      if (existingRecord) {
        stoppedIdentifiers.add(existingRecord.identifier);
      }
    }
    for (const { installation, record } of obsoleteInstallations) {
      if (await quiesceInstalledService(installation)) {
        stoppedIdentifiers.add(record.identifier);
      }
    }
    for (const installation of obsoleteInstallations) {
      disabledInstallations.push(installation);
      const { record } = installation;
      await runElevated('systemctl', ['disable', '--now', `${record.identifier}.service`]);
    }
    canonicalMutationStarted = true;
    runtime = await installUserRuntime(options, safeServiceKey(options));
    const serviceOptions = { ...options, nodePath: runtime.nodePath, cliPath: runtime.cliPath };
    await writeFile(temporaryPath, systemdDefinition(serviceOptions), { mode: 0o600 });
    await runElevated('install', ['-m', '0644', '--', temporaryPath, definitionPath]);
    await runElevated('systemctl', ['daemon-reload']);
    await runElevated('systemctl', ['enable', '--now', `${identifier}.service`]);
    await waitForStartupServiceReady({
      ...options,
      nodePath: runtime.nodePath,
      cliPath: runtime.cliPath,
    });
    if (plannedRecord.version !== 2) {
      throw new Error('The planned canonical service record must use version 2.');
    }
    await writeRecord(options, { ...plannedRecord, installationState: 'installed' });
    canonicalStarted = true;
    for (const { record } of obsoleteInstallations) {
      await runElevated('rm', ['-f', '--', record.definitionPath!]);
    }
    if (obsoleteInstallations.length > 0) {
      await runElevated('systemctl', ['daemon-reload']);
    }
    await Promise.all(
      obsoleteInstallations.map(({ installation }) => removeInstallationRecords(installation)),
    );
    await Promise.all(
      obsoleteInstallations.flatMap(({ record }) =>
        record.runtimeDirectory
          ? [rm(record.runtimeDirectory, { recursive: true, force: true })]
          : [],
      ),
    );
  } catch (error) {
    if (!canonicalStarted) {
      if (canonicalMutationStarted) {
        await runElevated('systemctl', ['disable', '--now', `${identifier}.service`]).catch(
          () => undefined,
        );
      }
      if (existingRecord && canonicalMutationStarted) {
        try {
          await Promise.all([
            replaceRuntimeFile(previousNodePath, existingRecord.nodePath, 'linux'),
            replaceRuntimeFile(previousCliPath, existingRecord.cliPath, 'linux'),
          ]);
          await runElevated('install', [
            '-m',
            '0644',
            '--',
            previousDefinitionPath,
            definitionPath,
          ]);
          await runElevated('systemctl', ['daemon-reload']);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'The canonical systemd update failed and its previous runtime could not be restored safely.',
          );
        }
      }
      const restoredIdentifiers = new Set<string>();
      const restoreCanonical = Boolean(
        existingRecord && stoppedIdentifiers.has(existingRecord.identifier),
      );
      if (!restoreCanonical) {
        for (const { record } of [...disabledInstallations].reverse()) {
          if (!stoppedIdentifiers.has(record.identifier)) {
            continue;
          }
          try {
            await runElevated('systemctl', ['enable', '--now', `${record.identifier}.service`]);
            restoredIdentifiers.add(record.identifier);
            break;
          } catch {
            await runElevated('systemctl', [
              'disable',
              '--now',
              `${record.identifier}.service`,
            ]).catch(() => undefined);
          }
        }
        for (const { record } of [...obsoleteInstallations].reverse()) {
          if (
            restoredIdentifiers.size > 0 ||
            !stoppedIdentifiers.has(record.identifier) ||
            disabledInstallations.some(
              ({ record: disabledRecord }) => disabledRecord.identifier === record.identifier,
            )
          ) {
            continue;
          }
          try {
            await runElevated('systemctl', ['start', `${record.identifier}.service`]);
            restoredIdentifiers.add(record.identifier);
          } catch {
            await runElevated('systemctl', [
              'disable',
              '--now',
              `${record.identifier}.service`,
            ]).catch(() => undefined);
          }
        }
      }
      if (existingRecord) {
        if (restoredIdentifiers.size > 0) {
          await runElevated('systemctl', [
            'disable',
            '--now',
            `${existingRecord.identifier}.service`,
          ]).catch(() => undefined);
        } else if (canonicalMutationStarted) {
          await runElevated('systemctl', [
            'enable',
            ...(restoreCanonical ? ['--now'] : []),
            `${existingRecord.identifier}.service`,
          ]).catch(() => undefined);
        } else if (restoreCanonical) {
          await runElevated('systemctl', ['start', `${existingRecord.identifier}.service`]).catch(
            () => undefined,
          );
        }
      }
    }
    throw error;
  } finally {
    await Promise.all([
      unlink(temporaryPath).catch(() => undefined),
      unlink(previousDefinitionPath).catch(() => undefined),
      unlink(previousNodePath).catch(() => undefined),
      unlink(previousCliPath).catch(() => undefined),
    ]);
  }
  return {
    definitionPath,
    nodePath: runtime!.nodePath,
    cliPath: runtime!.cliPath,
    runtimeDirectory: runtime!.runtimeDirectory,
  };
}

async function windowsTaskExists(
  runner: ServiceInstallCommandRunner,
  identifier: string,
): Promise<boolean> {
  return runner('schtasks.exe', ['/Query', '/TN', identifier])
    .then(() => true)
    .catch(() => false);
}

async function installWindows(
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

async function hasOwnedPersistentTarget(
  options: ServiceInstallOptions,
  record: ServiceInstallationRecord,
  runner: ServiceInstallCommandRunner,
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    if (!(await windowsTaskExists(runner, record.identifier))) {
      return false;
    }
    try {
      await assertOwnedWindowsStartupTask(runner, record);
      return true;
    } catch {
      return false;
    }
  }
  try {
    await assertOwnedDefinition(record.definitionPath!, { options, record }, true);
    return true;
  } catch {
    return false;
  }
}

async function installStartupServiceRecords(
  options: ServiceInstallOptions,
  obsoleteInstallations: ObsoleteServiceInstallation[],
): Promise<ServiceInstallResult> {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') {
    await ensurePersistentStatePaths(options.paths);
  } else {
    await ensureStatePaths(options.paths);
  }
  const key = safeServiceKey(options);
  const runner = options.runner ?? executeCommand;
  const identifier = serviceIdentifier(platform, key);
  const existingRecord = await readRecord(options);
  const previousRecord =
    existingRecord?.version === 2 && existingRecord.installationState === 'installing'
      ? await readPreviousRecord(options)
      : existingRecord;
  if (existingRecord && existingRecord === previousRecord) {
    await writePreviousRecord(options, existingRecord);
  }
  if (previousRecord?.version === 1) {
    await unlink(recordPath(options, 1)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  }
  const plannedRuntimeDirectory = expectedRuntimeDirectory(options, platform, key);
  const plannedRecord: ServiceInstallationRecord = {
    version: 2,
    packageVersion: options.currentVersion ?? PACKAGE_VERSION,
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    installationState: 'installing',
    platform,
    namespace: options.namespace,
    identifier,
    definitionPath: expectedDefinitionPath(options, platform, identifier),
    nodePath: path.join(plannedRuntimeDirectory, platform === 'win32' ? 'n.exe' : 'node'),
    cliPath: path.join(
      plannedRuntimeDirectory,
      platform === 'darwin' ? 'cli.js' : platform === 'win32' ? 'c.js' : `cli-${key}.js`,
    ),
    runtimeDirectory: plannedRuntimeDirectory,
    controlSocket: options.controlSocket ?? null,
    installedAt: new Date().toISOString(),
  };
  if (previousRecord) {
    await writeRecord(options, plannedRecord);
  } else {
    await unlink(recordPath(options, 2)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  }
  let definitionPath: string | null = null;
  let installedNodePath = options.nodePath;
  let installedCliPath = options.cliPath;
  let runtimeDirectory: string | undefined;
  try {
    if (platform === 'darwin') {
      const installed = await installMacos(
        options,
        runner,
        identifier,
        plannedRecord,
        previousRecord,
        obsoleteInstallations,
      );
      definitionPath = installed.definitionPath;
      installedNodePath = installed.nodePath;
      installedCliPath = installed.cliPath;
      runtimeDirectory = installed.runtimeDirectory;
    } else if (platform === 'linux') {
      const installed = await installLinux(
        options,
        runner,
        identifier,
        plannedRecord,
        previousRecord,
        obsoleteInstallations,
      );
      definitionPath = installed.definitionPath;
      installedNodePath = installed.nodePath;
      installedCliPath = installed.cliPath;
      runtimeDirectory = installed.runtimeDirectory;
    } else if (platform === 'win32') {
      const installed = await installWindows(
        options,
        runner,
        identifier,
        plannedRecord,
        previousRecord,
      );
      installedNodePath = installed.nodePath;
      installedCliPath = installed.cliPath;
      runtimeDirectory = installed.runtimeDirectory;
    } else {
      throw new Error(`Unsupported service platform: ${platform}`);
    }
  } catch (error) {
    const currentRecord = await readRecord(options).catch(() => null);
    const committed =
      currentRecord?.version === 2 &&
      plannedRecord.version === 2 &&
      currentRecord.installationState === 'installed' &&
      currentRecord.packageVersion === plannedRecord.packageVersion &&
      currentRecord.protocolVersion === plannedRecord.protocolVersion &&
      currentRecord.installedAt === plannedRecord.installedAt &&
      (await hasOwnedPersistentTarget(options, currentRecord, runner));
    if (committed) {
      throw error;
    }
    if (previousRecord) {
      if (await hasOwnedPersistentTarget(options, previousRecord, runner)) {
        await writeRecord(options, previousRecord);
        if (previousRecord.version === 1) {
          await unlink(recordPath(options, 2)).catch(() => undefined);
        }
        await unlink(previousRecordPath(options)).catch(() => undefined);
      }
    } else if (await hasOwnedPersistentTarget(options, plannedRecord, runner)) {
      await writeRecord(options, plannedRecord);
    } else {
      await unlink(recordPath(options, 2)).catch(() => undefined);
    }
    throw error;
  }
  const record: ServiceInstallationRecord = {
    version: 2,
    packageVersion: options.currentVersion ?? PACKAGE_VERSION,
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    installationState: 'installed',
    platform,
    namespace: options.namespace,
    identifier,
    definitionPath,
    nodePath: installedNodePath,
    cliPath: installedCliPath,
    runtimeDirectory,
    controlSocket: options.controlSocket ?? null,
    installedAt: new Date().toISOString(),
  };
  await writeRecord(options, record);
  await unlink(recordPath(options, 1)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });
  await unlink(previousRecordPath(options)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });
  return { installed: true, record };
}

function assertCanonicalInstallation(options: ServiceInstallOptions): void {
  if (options.namespace !== CANONICAL_SERVICE_NAMESPACE) {
    throw new Error(
      'Port 443 has one machine-wide startup service. Install the canonical `default` service instead of a namespaced startup service.',
    );
  }
  if (options.controlSocket !== undefined) {
    throw new Error(
      'The canonical startup service has one control channel. Omit `controlSocket` when installing it.',
    );
  }
}

function newerIncompatibleError(): Error {
  return new Error(
    'A newer installed local TLS service uses an incompatible control protocol. Update this project to the newer plugin version; the installed runtime was left unchanged.',
  );
}

export async function installStartupService(
  options: ServiceInstallOptions,
): Promise<ServiceInstallResult> {
  assertCanonicalInstallation(options);
  const updateStatus = await getStartupServiceUpdateStatus(options);
  if (updateStatus === 'newer') {
    return startStartupService(options);
  }
  if (updateStatus === 'newer-incompatible') {
    throw newerIncompatibleError();
  }
  return installStartupServiceRecords(options, []);
}

export async function replaceStartupService(
  options: ServiceInstallOptions,
  obsoleteInstallations: ServiceInstallOptions[],
): Promise<ServiceInstallResult> {
  assertCanonicalInstallation(options);
  const updateStatus = await getStartupServiceUpdateStatus(options);
  if (updateStatus === 'newer') {
    return startStartupService(options, obsoleteInstallations);
  }
  if (updateStatus === 'newer-incompatible') {
    throw newerIncompatibleError();
  }
  const platform = options.platform ?? process.platform;
  const obsolete = await Promise.all(
    obsoleteInstallations.map(async (installation) => {
      const record = await readRecord(installation);
      if (!record) {
        return null;
      }
      if (record.platform !== platform || record.namespace === CANONICAL_SERVICE_NAMESPACE) {
        throw new Error('Refusing to replace a startup service outside the legacy target set.');
      }
      return { installation: optionsForInstallationRecord(installation, record), record };
    }),
  );
  const existing = obsolete.filter(
    (item): item is { installation: ServiceInstallOptions; record: ServiceInstallationRecord } =>
      item !== null,
  );
  if (platform === 'win32') {
    const runner = options.runner ?? executeCommand;
    const initialCanonicalRecord = await readRecord(options);
    const initialCanonicalWasRunning = initialCanonicalRecord
      ? (
          await installedService(
            optionsForInstallationRecord(options, initialCanonicalRecord),
          ).status()
        ).running
      : false;
    if (await windowsTaskExists(runner, serviceIdentifier(platform, safeServiceKey(options)))) {
      if (!initialCanonicalRecord) {
        throw new Error('Refusing to replace an unrelated canonical scheduled task.');
      }
      await assertOwnedWindowsStartupTask(runner, initialCanonicalRecord);
    }
    for (const { record } of existing) {
      await assertOwnedWindowsStartupTask(runner, record);
    }
    const disabled: ObsoleteServiceInstallation[] = [];
    const stoppedIdentifiers = new Set<string>();
    let canonicalInstallAttempted = false;
    let result: ServiceInstallResult;
    try {
      for (const item of existing) {
        if (await quiesceInstalledService(item.installation)) {
          stoppedIdentifiers.add(item.record.identifier);
        }
      }
      for (const item of existing) {
        disabled.push(item);
        await runner('schtasks.exe', ['/Change', '/TN', item.record.identifier, '/Disable']);
      }
      canonicalInstallAttempted = true;
      result = await installStartupServiceRecords(options, []);
    } catch (error) {
      let canonicalRecord = canonicalInstallAttempted
        ? await readRecord(options).catch(() => null)
        : null;
      let canonicalOwned = canonicalRecord
        ? await hasOwnedPersistentTarget(options, canonicalRecord, runner)
        : false;
      const previousCanonicalOwned = initialCanonicalRecord
        ? await hasOwnedPersistentTarget(options, initialCanonicalRecord, runner)
        : false;
      if (canonicalOwned && !previousCanonicalOwned) {
        await uninstallStartupService(options).catch(() => undefined);
        canonicalRecord = await readRecord(options).catch(() => null);
        canonicalOwned = canonicalRecord
          ? await hasOwnedPersistentTarget(options, canonicalRecord, runner)
          : false;
      }
      const canonicalTargetPresent = await windowsTaskExists(
        runner,
        serviceIdentifier(platform, safeServiceKey(options)),
      );
      let canonicalDisabledForLegacy = !canonicalTargetPresent;
      if (
        canonicalTargetPresent &&
        previousCanonicalOwned &&
        !initialCanonicalWasRunning &&
        stoppedIdentifiers.size > 0
      ) {
        await runner('schtasks.exe', [
          '/End',
          '/TN',
          serviceIdentifier(platform, safeServiceKey(options)),
        ]).catch(() => undefined);
        canonicalDisabledForLegacy = await runner('schtasks.exe', [
          '/Change',
          '/TN',
          serviceIdentifier(platform, safeServiceKey(options)),
          '/Disable',
        ])
          .then(() => true)
          .catch(() => false);
      }
      if (
        stoppedIdentifiers.size > 0 &&
        ((!canonicalOwned && !canonicalTargetPresent) || canonicalDisabledForLegacy)
      ) {
        const restoredIdentifiers = new Set<string>();
        for (const item of [...disabled].reverse()) {
          if (restoredIdentifiers.size > 0 || !stoppedIdentifiers.has(item.record.identifier)) {
            continue;
          }
          try {
            await runner('schtasks.exe', ['/Change', '/TN', item.record.identifier, '/Enable']);
            await runner('schtasks.exe', ['/Run', '/TN', item.record.identifier]);
            restoredIdentifiers.add(item.record.identifier);
          } catch {
            await runner('schtasks.exe', [
              '/Change',
              '/TN',
              item.record.identifier,
              '/Disable',
            ]).catch(() => undefined);
            continue;
          }
        }
        for (const item of [...existing].reverse()) {
          if (
            restoredIdentifiers.size > 0 ||
            !stoppedIdentifiers.has(item.record.identifier) ||
            disabled.some(
              ({ record: disabledRecord }) => disabledRecord.identifier === item.record.identifier,
            )
          ) {
            continue;
          }
          try {
            await runner('schtasks.exe', ['/Run', '/TN', item.record.identifier]);
            restoredIdentifiers.add(item.record.identifier);
            break;
          } catch {
            await runner('schtasks.exe', [
              '/Change',
              '/TN',
              item.record.identifier,
              '/Disable',
            ]).catch(() => undefined);
          }
        }
      }
      throw error;
    }
    for (const { installation } of existing) {
      await uninstallStartupService(installation);
    }
    return result;
  }
  const result = await installStartupServiceRecords(options, existing);
  await Promise.all(existing.map(({ installation }) => removeInstallationRecords(installation)));
  return result;
}

export async function startStartupService(
  options: ServiceInstallOptions,
  obsoleteInstallations: ServiceInstallOptions[] = [],
): Promise<ServiceInstallResult> {
  assertCanonicalInstallation(options);
  if ((await getStartupServiceUpdateStatus(options)) === 'newer-incompatible') {
    throw newerIncompatibleError();
  }
  const record = await readRecord(options);
  if (!record) {
    throw new Error('The canonical startup service is not installed.');
  }
  const canonicalOptions = optionsForInstallationRecord(options, record);
  const platform = options.platform ?? process.platform;
  const obsolete = await Promise.all(
    obsoleteInstallations.map(async (installation) => {
      const obsoleteRecord = await readRecord(installation);
      if (!obsoleteRecord) {
        return null;
      }
      if (
        obsoleteRecord.platform !== platform ||
        obsoleteRecord.namespace === CANONICAL_SERVICE_NAMESPACE
      ) {
        throw new Error('Refusing to start a service outside the legacy target set.');
      }
      return {
        installation: optionsForInstallationRecord(installation, obsoleteRecord),
        record: obsoleteRecord,
      };
    }),
  );
  const existing = obsolete.filter(
    (item): item is { installation: ServiceInstallOptions; record: ServiceInstallationRecord } =>
      item !== null,
  );
  const canonicalStatus = await installedService(canonicalOptions).status();
  if (canonicalStatus.running && !canonicalStatus.compatible) {
    throw new Error(
      `The canonical startup service uses incompatible control protocol ${canonicalStatus.protocolVersion}. It was left unchanged.`,
    );
  }
  const restartCanonical = !(canonicalStatus.running && canonicalStatus.activeRoutes > 0);
  if (!restartCanonical && existing.length === 0) {
    return { installed: true, record };
  }
  const runner = options.runner ?? executeCommand;
  if (platform === 'darwin') {
    await assertOwnedDefinition(
      record.definitionPath!,
      { options: canonicalOptions, record },
      true,
    );
    for (const item of existing) {
      await assertOwnedDefinition(
        item.record.definitionPath!,
        {
          options: item.installation,
          record: item.record,
        },
        true,
      );
    }
    const trackedInstallations = await inspectRunningInstallations([
      ...existing,
      ...(restartCanonical ? [{ installation: canonicalOptions, record }] : []),
    ]);
    const trackedExisting = trackedInstallations.filter(
      ({ record: trackedRecord }) => trackedRecord !== record,
    );
    const trackedCanonical = trackedInstallations.find(
      ({ record: trackedRecord }) => trackedRecord === record,
    );
    const rollbackWinnerIdentifier =
      (trackedCanonical?.wasRunning ? trackedCanonical.record.identifier : null) ??
      trackedExisting.find(({ wasRunning }) => wasRunning)?.record.identifier ??
      null;
    const rollbackExisting = trackedExisting.map((installation) => ({
      ...installation,
      wasRunning: installation.record.identifier === rollbackWinnerIdentifier,
    }));
    const rollbackCanonical = trackedCanonical
      ? {
          ...trackedCanonical,
          wasRunning: trackedCanonical.record.identifier === rollbackWinnerIdentifier,
        }
      : null;
    const controlClient = await stageMacosControlClient(options);
    try {
      await runElevatedCommands(options, runner, [
        ...macosQuiesceCommands(rollbackExisting, false, controlClient),
        ...(restartCanonical
          ? macosQuiesceCommands(
              [rollbackCanonical!],
              rollbackWinnerIdentifier === null,
              controlClient,
            )
          : []),
        ...macosBootoutCommands(trackedExisting, !restartCanonical),
        ...(restartCanonical
          ? [
              {
                command: 'launchctl',
                arguments_: ['enable', `system/${record.identifier}`],
                rollbackAfterSuccess: [
                  {
                    command: 'launchctl',
                    arguments_: ['disable', `system/${record.identifier}`],
                  },
                  {
                    command: 'launchctl',
                    arguments_: ['bootout', `system/${record.identifier}`],
                    allowFailure: true,
                  },
                  {
                    command: process.execPath,
                    arguments_: [
                      '--input-type=module',
                      '--eval',
                      MACOS_LAUNCHD_REMOVAL_WAIT_SOURCE,
                      record.identifier,
                    ],
                  },
                ],
              },
              {
                command: 'launchctl',
                arguments_: ['kickstart', '-k', `system/${record.identifier}`],
              },
              macosReadinessCommand(
                record.nodePath,
                record.cliPath,
                record.namespace,
                canonicalOptions.paths.socketPath,
              ),
            ]
          : []),
        ...macosCleanupCommands(trackedExisting),
      ]);
    } finally {
      await unlink(controlClient.cliPath).catch(() => undefined);
    }
  } else if (platform === 'linux') {
    await assertOwnedDefinition(
      record.definitionPath!,
      { options: canonicalOptions, record },
      true,
    );
    for (const item of existing) {
      await assertOwnedDefinition(
        item.record.definitionPath!,
        {
          options: item.installation,
          record: item.record,
        },
        true,
      );
    }
    const disabled: ObsoleteServiceInstallation[] = [];
    const stoppedIdentifiers = new Set<string>();
    let committed = false;
    try {
      if (restartCanonical && (await quiesceInstalledService(canonicalOptions))) {
        stoppedIdentifiers.add(record.identifier);
      }
      for (const item of existing) {
        if (await quiesceInstalledService(item.installation)) {
          stoppedIdentifiers.add(item.record.identifier);
        }
      }
      for (const item of existing) {
        disabled.push(item);
        await runElevatedCommand(options, runner, 'systemctl', [
          'disable',
          '--now',
          `${item.record.identifier}.service`,
        ]);
      }
      if (restartCanonical) {
        await runElevatedCommand(options, runner, 'systemctl', [
          'start',
          `${record.identifier}.service`,
        ]);
        await waitForStartupServiceReady(canonicalOptions);
      }
      committed = true;
      for (const item of existing) {
        await runElevatedCommand(options, runner, 'rm', ['-f', '--', item.record.definitionPath!]);
      }
      if (existing.length > 0) {
        await runElevatedCommand(options, runner, 'systemctl', ['daemon-reload']);
      }
      await Promise.all(
        existing.map(({ installation }) => removeInstallationRecords(installation)),
      );
      await Promise.all(
        existing.flatMap((item) =>
          item.record.runtimeDirectory
            ? [rm(item.record.runtimeDirectory, { recursive: true, force: true })]
            : [],
        ),
      );
    } catch (error) {
      if (!committed) {
        if (restartCanonical) {
          await runElevatedCommand(options, runner, 'systemctl', [
            'stop',
            `${record.identifier}.service`,
          ]).catch(() => undefined);
        }
        const restoredIdentifiers = new Set<string>();
        const restoreCanonical = stoppedIdentifiers.has(record.identifier);
        if (!restoreCanonical) {
          for (const item of [...disabled].reverse()) {
            if (restoredIdentifiers.size > 0 || !stoppedIdentifiers.has(item.record.identifier)) {
              continue;
            }
            try {
              await runElevatedCommand(options, runner, 'systemctl', [
                'enable',
                '--now',
                `${item.record.identifier}.service`,
              ]);
              restoredIdentifiers.add(item.record.identifier);
            } catch {
              await runElevatedCommand(options, runner, 'systemctl', [
                'disable',
                '--now',
                `${item.record.identifier}.service`,
              ]).catch(() => undefined);
              continue;
            }
          }
        }
        for (const item of [...existing].reverse()) {
          if (
            restoredIdentifiers.size > 0 ||
            !stoppedIdentifiers.has(item.record.identifier) ||
            disabled.some(
              ({ record: disabledRecord }) => disabledRecord.identifier === item.record.identifier,
            )
          ) {
            continue;
          }
          try {
            await runElevatedCommand(options, runner, 'systemctl', [
              'start',
              `${item.record.identifier}.service`,
            ]);
            restoredIdentifiers.add(item.record.identifier);
          } catch {
            await runElevatedCommand(options, runner, 'systemctl', [
              'disable',
              '--now',
              `${item.record.identifier}.service`,
            ]).catch(() => undefined);
          }
        }
        if (restartCanonical && restoredIdentifiers.size > 0) {
          await runElevatedCommand(options, runner, 'systemctl', [
            'disable',
            '--now',
            `${record.identifier}.service`,
          ]).catch(() => undefined);
        } else if (restartCanonical && restoreCanonical) {
          await runElevatedCommand(options, runner, 'systemctl', [
            'start',
            `${record.identifier}.service`,
          ]).catch(() => undefined);
        }
      }
      throw error;
    }
  } else if (platform === 'win32') {
    await assertOwnedWindowsStartupTask(runner, record);
    for (const item of existing) {
      await assertOwnedWindowsStartupTask(runner, item.record);
    }
    const stoppedIdentifiers = new Set<string>();
    const disabled: ObsoleteServiceInstallation[] = [];
    let committed = false;
    try {
      if (restartCanonical && (await quiesceInstalledService(canonicalOptions))) {
        stoppedIdentifiers.add(record.identifier);
      }
      for (const item of existing) {
        if (await quiesceInstalledService(item.installation)) {
          stoppedIdentifiers.add(item.record.identifier);
        }
      }
      for (const item of existing) {
        disabled.push(item);
        await runner('schtasks.exe', ['/Change', '/TN', item.record.identifier, '/Disable']);
      }
      if (restartCanonical) {
        await runner('schtasks.exe', ['/Change', '/TN', record.identifier, '/Enable']);
        await runner('schtasks.exe', ['/Run', '/TN', record.identifier]);
        await waitForStartupServiceReady(canonicalOptions);
      }
      committed = true;
      for (const item of existing) {
        await uninstallStartupService(item.installation);
      }
    } catch (error) {
      if (!committed) {
        if (restartCanonical) {
          await runner('schtasks.exe', ['/Change', '/TN', record.identifier, '/Disable']).catch(
            () => undefined,
          );
        }
        const restoredIdentifiers = new Set<string>();
        const restoreCanonical = stoppedIdentifiers.has(record.identifier);
        if (!restoreCanonical) {
          for (const item of [...disabled].reverse()) {
            if (restoredIdentifiers.size > 0 || !stoppedIdentifiers.has(item.record.identifier)) {
              continue;
            }
            try {
              await runner('schtasks.exe', ['/Change', '/TN', item.record.identifier, '/Enable']);
              await runner('schtasks.exe', ['/Run', '/TN', item.record.identifier]);
              restoredIdentifiers.add(item.record.identifier);
            } catch {
              await runner('schtasks.exe', [
                '/Change',
                '/TN',
                item.record.identifier,
                '/Disable',
              ]).catch(() => undefined);
              continue;
            }
          }
        }
        for (const item of [...existing].reverse()) {
          if (
            restoredIdentifiers.size > 0 ||
            !stoppedIdentifiers.has(item.record.identifier) ||
            disabled.some(
              ({ record: disabledRecord }) => disabledRecord.identifier === item.record.identifier,
            )
          ) {
            continue;
          }
          try {
            await runner('schtasks.exe', ['/Run', '/TN', item.record.identifier]);
            restoredIdentifiers.add(item.record.identifier);
            break;
          } catch {
            await runner('schtasks.exe', [
              '/Change',
              '/TN',
              item.record.identifier,
              '/Disable',
            ]).catch(() => undefined);
          }
        }
        if (restartCanonical && restoredIdentifiers.size === 0) {
          await runner('schtasks.exe', ['/Change', '/TN', record.identifier, '/Enable']).catch(
            () => undefined,
          );
          if (restoreCanonical) {
            await runner('schtasks.exe', ['/Run', '/TN', record.identifier]).catch(() => undefined);
          }
        }
      }
      throw error;
    }
  } else {
    throw new Error(`Unsupported service platform: ${platform}`);
  }
  if (platform !== 'win32') {
    await Promise.all(existing.map(({ installation }) => removeInstallationRecords(installation)));
  }
  return { installed: true, record };
}

export async function startOwnedStartupService(
  options: ServiceInstallOptions,
): Promise<ServiceInstallResult> {
  const record = await readRecord(options);
  if (!record) {
    throw new Error(`Startup service ${options.namespace} is not installed.`);
  }
  const installedOptions = optionsForInstallationRecord(options, record);
  const runner = options.runner ?? executeCommand;
  if (record.platform === 'darwin') {
    await assertOwnedDefinition(
      record.definitionPath!,
      { options: installedOptions, record },
      true,
    );
    await runElevatedCommands(options, runner, [
      { command: 'launchctl', arguments_: ['enable', `system/${record.identifier}`] },
      { command: 'launchctl', arguments_: ['kickstart', '-k', `system/${record.identifier}`] },
    ]);
  } else if (record.platform === 'linux') {
    await assertOwnedDefinition(
      record.definitionPath!,
      { options: installedOptions, record },
      true,
    );
    await runElevatedCommand(options, runner, 'systemctl', [
      'start',
      `${record.identifier}.service`,
    ]);
  } else if (record.platform === 'win32') {
    await assertOwnedWindowsStartupTask(runner, record);
    await runner('schtasks.exe', ['/Run', '/TN', record.identifier]);
  } else {
    throw new Error(`Unsupported service platform: ${record.platform}`);
  }
  return { installed: true, record };
}

export async function uninstallStartupService(
  options: ServiceInstallOptions,
): Promise<ServiceInstallResult> {
  const record = await readRecord(options);
  if (!record) {
    return { installed: false, record: null };
  }
  const installedOptions = optionsForInstallationRecord(options, record);
  const runner = options.runner ?? executeCommand;
  if (record.platform === 'darwin') {
    await assertOwnedDefinition(
      record.definitionPath!,
      { options: installedOptions, record },
      true,
    );
    const trackedInstallation = (
      await inspectRunningInstallations([{ installation: installedOptions, record }])
    )[0]!;
    const controlClient = await stageMacosControlClient(options);
    try {
      const commands: ServiceInstallElevatedCommand[] = [
        ...macosQuiesceCommands([trackedInstallation], true, controlClient),
        {
          command: 'launchctl',
          arguments_: ['bootout', `system/${record.identifier}`],
          allowFailure: true,
        },
        {
          command: process.execPath,
          arguments_: [
            '--input-type=module',
            '--eval',
            MACOS_LAUNCHD_REMOVAL_WAIT_SOURCE,
            record.identifier,
          ],
        },
        ...macosCleanupCommands([trackedInstallation]),
      ];
      await runElevatedCommands(options, runner, commands);
    } finally {
      await unlink(controlClient.cliPath).catch(() => undefined);
    }
  } else if (record.platform === 'linux') {
    await assertOwnedDefinition(
      record.definitionPath!,
      { options: installedOptions, record },
      true,
    );
    await quiesceInstalledService(installedOptions);
    async function runElevated(command: string, arguments_: string[]): Promise<void> {
      await runElevatedCommand(options, runner, command, arguments_);
    }
    await runElevated('systemctl', ['disable', '--now', `${record.identifier}.service`]);
    await runElevated('rm', ['-f', '--', record.definitionPath!]);
    await runElevated('systemctl', ['daemon-reload']);
    await removeInstallationRecords(options);
    if (record.runtimeDirectory) {
      await rm(record.runtimeDirectory, { recursive: true, force: true });
    }
  } else if (record.platform === 'win32') {
    await assertOwnedWindowsStartupTask(runner, record);
    await quiesceInstalledService(installedOptions);
    await runner('schtasks.exe', ['/End', '/TN', record.identifier]).catch(() => undefined);
    await runner('schtasks.exe', ['/Delete', '/TN', record.identifier, '/F']);
    await removeInstallationRecords(options);
    if (record.runtimeDirectory) {
      await rm(record.runtimeDirectory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  }
  await removeInstallationRecords(options);
  return { installed: false, record };
}
