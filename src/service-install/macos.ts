import { randomUUID } from 'node:crypto';
import { chmod, copyFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ServiceInstallCommandRunner,
  ServiceInstallElevatedCommand,
  ServiceInstallationRecord,
  ServiceInstallOptions,
} from '../interfaces/service-install-options.js';
import type { MacosControlClient, ObsoleteServiceInstallation } from './shared.js';
import {
  assertOwnedDefinition,
  expectedRuntimeDirectory,
  inspectRunningInstallations,
  launchdDefinition,
  optionsForInstallationRecord,
  previousRecordPath,
  quiesceInstalledService,
  recordPath,
  runElevatedCommands,
  safeServiceKey,
  serviceBackupKey,
  stageRegularFileBackup,
} from './shared.js';

export const MACOS_LAUNCHD_REMOVAL_WAIT_SOURCE = [
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

export const MACOS_SERVICE_READINESS_WAIT_SOURCE = [
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

export function macosBootoutCommands(
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

export function macosCleanupCommands(
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

export function macosQuiesceCommands(
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

export async function stageMacosControlClient(
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

export function macosReadinessCommand(
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

export async function installMacos(
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
