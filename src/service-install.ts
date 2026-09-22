import { readFile, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import type {
  ServiceInstallCommandRunner,
  ServiceInstallElevatedCommand,
  ServiceInstallationRecord,
  ServiceInstallOptions,
  ServiceInstallResult,
  StartupServiceUpdateStatus,
} from './interfaces/service-install-options.js';
import { executeCommand } from './command-runner.js';
import { CONTROL_PROTOCOL_VERSION } from './control-protocol.js';
import { PACKAGE_VERSION } from './package-version.js';
import { compareServiceVersions } from './service-version.js';
import { ensurePersistentStatePaths, ensureStatePaths } from './state-paths.js';
import type { ObsoleteServiceInstallation } from './service-install/shared.js';
import {
  CANONICAL_SERVICE_NAMESPACE,
  assertOwnedDefinition,
  expectedDefinitionPath,
  expectedRuntimeDirectory,
  inspectRunningInstallations,
  installedService,
  optionsForInstallationRecord,
  previousRecordPath,
  quiesceInstalledService,
  readPreviousRecord,
  readRecord,
  recordPath,
  removeInstallationRecords,
  runElevatedCommand,
  runElevatedCommands,
  safeServiceKey,
  serviceIdentifier,
  waitForStartupServiceReady,
  writePreviousRecord,
  writeRecord,
} from './service-install/shared.js';
import {
  installMacos,
  MACOS_LAUNCHD_REMOVAL_WAIT_SOURCE,
  macosBootoutCommands,
  macosCleanupCommands,
  macosQuiesceCommands,
  macosReadinessCommand,
  stageMacosControlClient,
} from './service-install/macos.js';
import { installLinux } from './service-install/linux.js';
import {
  assertOwnedWindowsStartupTask,
  installWindows,
  windowsTaskExists,
} from './service-install/windows.js';

export { assertOwnedWindowsStartupTask } from './service-install/windows.js';

export {
  CANONICAL_SERVICE_NAMESPACE,
  expectedDefinitionPath,
  expectedRuntimeDirectory,
  serviceDefinitionMatchesInstallation,
  serviceIdentifier,
  STARTUP_SERVICE_OWNER_MARKER,
} from './service-install/shared.js';

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
