import { rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ServiceInstallCommandResult,
  ServiceInstallCommandRunner,
  ServiceInstallationRecord,
  ServiceInstallOptions,
} from '../interfaces/service-install-options.js';
import type { ObsoleteServiceInstallation } from './shared.js';
import {
  assertOwnedDefinition,
  installUserRuntime,
  optionsForInstallationRecord,
  quiesceInstalledService,
  removeInstallationRecords,
  replaceRuntimeFile,
  runElevatedCommand,
  safeServiceKey,
  serviceBackupKey,
  stageRegularFileBackup,
  systemdDefinition,
  waitForStartupServiceReady,
  writeRecord,
} from './shared.js';

export async function installLinux(
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
