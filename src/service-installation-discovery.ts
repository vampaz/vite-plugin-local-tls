import { lstat, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  DiscoveredStartupServiceInstallation,
  InvalidStartupServiceInstallation,
  InvalidStartupServiceReason,
  StartupServiceDiscoveryOptions,
  StartupServiceInstallationInventory,
} from './interfaces/service-installation-inventory.js';
import type { ServiceInstallationRecord } from './interfaces/service-install-options.js';
import { executeCommand } from './command-runner.js';
import {
  assertOwnedWindowsStartupTask,
  CANONICAL_SERVICE_NAMESPACE,
  expectedDefinitionPath,
  expectedRuntimeDirectory,
  serviceDefinitionMatchesInstallation,
  serviceIdentifier,
} from './service-install.js';
import { compareServiceVersions } from './service-version.js';
import { getStatePaths, sanitizeNamespace } from './state-paths.js';

const RECORD_FILENAMES = [
  'service-install-v2.json',
  'service-install.json',
  'service-install-previous.json',
] as const;

class DiscoveryValidationError extends Error {
  readonly reason: InvalidStartupServiceReason;

  constructor(reason: InvalidStartupServiceReason, message: string) {
    super(message);
    this.name = 'DiscoveryValidationError';
    this.reason = reason;
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function runtimeDirectory(
  options: StartupServiceDiscoveryOptions,
  record: ServiceInstallationRecord,
): string {
  if ((options.platform ?? process.platform) === 'darwin' && options.runtimeRootDirectory) {
    return path.join(options.runtimeRootDirectory, sanitizeNamespace(record.namespace));
  }
  return expectedRuntimeDirectory(
    {
      platform: options.platform,
      namespace: record.namespace,
      paths: getStatePaths(
        record.namespace,
        options.platform ?? process.platform,
        options.environment ?? process.env,
      ),
      nodePath: options.nodePath,
      cliPath: options.cliPath,
    },
    options.platform ?? process.platform,
    sanitizeNamespace(record.namespace),
  );
}

function assertRecordShape(
  value: unknown,
  namespaceDirectory: string,
  expectedVersion: 1 | 2,
  options: StartupServiceDiscoveryOptions,
): ServiceInstallationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DiscoveryValidationError('corrupt-record', 'Record is not a JSON object.');
  }
  const record = value as Partial<ServiceInstallationRecord> & Record<string, unknown>;
  const platform = options.platform ?? process.platform;
  const namespaceHasControlCharacter =
    typeof record.namespace === 'string' &&
    [...record.namespace].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    });
  const controlSocketHasControlCharacter =
    typeof record.controlSocket === 'string' &&
    [...record.controlSocket].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    });
  if (
    record.version !== expectedVersion ||
    record.platform !== platform ||
    typeof record.namespace !== 'string' ||
    !record.namespace ||
    record.namespace.length > 256 ||
    namespaceHasControlCharacter ||
    typeof record.identifier !== 'string' ||
    (record.definitionPath !== null && typeof record.definitionPath !== 'string') ||
    typeof record.nodePath !== 'string' ||
    typeof record.cliPath !== 'string' ||
    typeof record.runtimeDirectory !== 'string' ||
    (record.controlSocket !== null &&
      (typeof record.controlSocket !== 'string' ||
        !record.controlSocket ||
        record.controlSocket.length > 4096 ||
        controlSocketHasControlCharacter)) ||
    !isCanonicalTimestamp(record.installedAt) ||
    (record.version === 2 &&
      (typeof record.packageVersion !== 'string' ||
        compareServiceVersions(record.packageVersion, record.packageVersion) !== 0 ||
        !Number.isInteger(record.protocolVersion) ||
        Number(record.protocolVersion) < 1 ||
        (record.installationState !== 'installing' && record.installationState !== 'installed')))
  ) {
    throw new DiscoveryValidationError(
      'corrupt-record',
      'Record is incomplete or belongs to another platform.',
    );
  }
  const installation = record as ServiceInstallationRecord;
  const safeNamespace = sanitizeNamespace(installation.namespace);
  const paths = getStatePaths(installation.namespace, platform, options.environment ?? process.env);
  const identifier = serviceIdentifier(platform, safeNamespace);
  const definitionPath = expectedDefinitionPath(
    {
      platform,
      namespace: installation.namespace,
      paths,
      nodePath: options.nodePath,
      cliPath: options.cliPath,
      definitionDirectory: options.definitionDirectory,
    },
    platform,
    identifier,
  );
  const expectedRuntime = runtimeDirectory(options, installation);
  const expectedNodePath = path.join(expectedRuntime, platform === 'win32' ? 'n.exe' : 'node');
  const expectedCliPath = path.join(
    expectedRuntime,
    platform === 'darwin' ? 'cli.js' : platform === 'win32' ? 'c.js' : `cli-${safeNamespace}.js`,
  );
  if (
    safeNamespace !== namespaceDirectory ||
    installation.identifier !== identifier ||
    installation.definitionPath !== definitionPath ||
    installation.runtimeDirectory !== expectedRuntime ||
    installation.nodePath !== expectedNodePath ||
    installation.cliPath !== expectedCliPath
  ) {
    throw new DiscoveryValidationError(
      'unsafe-target',
      'Record points outside the expected owned service targets.',
    );
  }
  return installation;
}

async function assertRecordFile(recordPath: string): Promise<void> {
  const details = await lstat(recordPath);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new DiscoveryValidationError(
      'unsafe-record',
      'Installation record is not a regular file.',
    );
  }
}

async function assertOwnedDefinition(
  record: ServiceInstallationRecord,
  options: ReturnType<typeof installationOptions>,
  discovery: StartupServiceDiscoveryOptions,
): Promise<void> {
  if (record.platform === 'win32') {
    try {
      await assertOwnedWindowsStartupTask(discovery.runner ?? executeCommand, record);
    } catch {
      throw new DiscoveryValidationError(
        'unrelated-definition',
        'Recorded scheduled task does not match this user and runtime.',
      );
    }
    return;
  }
  try {
    const details = await lstat(record.definitionPath!);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new DiscoveryValidationError(
        'unrelated-definition',
        'Recorded service definition is not a regular file.',
      );
    }
    const contents = await readFile(record.definitionPath!, 'utf8');
    if (!serviceDefinitionMatchesInstallation(contents, options, record)) {
      throw new DiscoveryValidationError(
        'unrelated-definition',
        'Recorded service definition does not match this user and runtime.',
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DiscoveryValidationError(
        'missing-definition',
        'Recorded service definition is missing.',
      );
    }
    throw error;
  }
}

function installationOptions(
  discovery: StartupServiceDiscoveryOptions,
  record: ServiceInstallationRecord,
) {
  const platform = discovery.platform ?? process.platform;
  const environment = discovery.environment ?? process.env;
  const basePaths = getStatePaths(record.namespace, platform, environment);
  const paths = record.controlSocket
    ? { ...basePaths, socketPath: record.controlSocket }
    : basePaths;
  return {
    platform,
    namespace: record.namespace,
    paths,
    nodePath: discovery.nodePath,
    cliPath: discovery.cliPath,
    homeDirectory: environment.HOME ?? environment.USERPROFILE ?? os.homedir(),
    username: environment.USERNAME ?? environment.USER ?? os.userInfo().username,
    definitionDirectory: discovery.definitionDirectory,
    runtimeInstallDirectory: record.runtimeDirectory,
    controlSocket: record.controlSocket ?? undefined,
    useSudo: discovery.useSudo,
  };
}

function invalidInstallation(
  namespace: string,
  recordPath: string,
  error: unknown,
): InvalidStartupServiceInstallation {
  return {
    namespace,
    recordPath,
    reason: error instanceof DiscoveryValidationError ? error.reason : 'corrupt-record',
    message: error instanceof Error ? error.message : String(error),
  };
}

async function discoverRecord(
  stateRoot: string,
  namespaceDirectory: string,
  options: StartupServiceDiscoveryOptions,
): Promise<DiscoveredStartupServiceInstallation | InvalidStartupServiceInstallation | null> {
  const namespacePath = path.join(stateRoot, namespaceDirectory);
  try {
    const details = await lstat(namespacePath);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new DiscoveryValidationError(
        'unsafe-record',
        'Namespace state path is not a regular directory.',
      );
    }
  } catch (error) {
    return invalidInstallation(namespaceDirectory, namespacePath, error);
  }
  let recordPath: string | null = null;
  let recordVersion: 1 | 2 | null = 2;
  for (const filename of RECORD_FILENAMES) {
    const candidate = path.join(stateRoot, namespaceDirectory, filename);
    try {
      await lstat(candidate);
      recordPath = candidate;
      recordVersion =
        filename === 'service-install-v2.json' ? 2 : filename === 'service-install.json' ? 1 : null;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return invalidInstallation(namespaceDirectory, candidate, error);
      }
    }
  }
  if (!recordPath) {
    return null;
  }
  try {
    await assertRecordFile(recordPath);
    const recordValue = JSON.parse(await readFile(recordPath, 'utf8')) as unknown;
    const parsedVersion = (recordValue as { version?: unknown } | null)?.version;
    if (recordVersion === null && parsedVersion !== 1 && parsedVersion !== 2) {
      throw new DiscoveryValidationError(
        'corrupt-record',
        'Recovery record has no supported installation version.',
      );
    }
    const record = assertRecordShape(
      recordValue,
      namespaceDirectory,
      recordVersion ?? (parsedVersion as 1 | 2),
      options,
    );
    if (
      recordPath.endsWith('service-install-previous.json') &&
      record.version === 2 &&
      record.installationState !== 'installed'
    ) {
      throw new DiscoveryValidationError(
        'corrupt-record',
        'Recovery record is not a completed installation.',
      );
    }
    const ownershipCandidates = [record];
    if (record.version === 2 && record.installationState === 'installing') {
      if (record.namespace !== CANONICAL_SERVICE_NAMESPACE) {
        throw new DiscoveryValidationError(
          'corrupt-record',
          'Interrupted noncanonical installation requires inspection by its originating project.',
        );
      }
      const previousPath = path.join(
        stateRoot,
        namespaceDirectory,
        'service-install-previous.json',
      );
      try {
        await assertRecordFile(previousPath);
        const previousValue = JSON.parse(await readFile(previousPath, 'utf8')) as unknown;
        const previousVersion = (previousValue as { version?: unknown } | null)?.version;
        if (previousVersion !== 1 && previousVersion !== 2) {
          throw new Error('Previous record has no supported version.');
        }
        const previous = assertRecordShape(
          previousValue,
          namespaceDirectory,
          previousVersion,
          options,
        );
        if (previous.version === 2 && previous.installationState !== 'installed') {
          throw new Error('Previous record is not a completed installation.');
        }
        ownershipCandidates.push(previous);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // A first installation has no previous canonical owner. Its exact pending
          // definition is sufficient to make the interrupted transaction retryable.
        } else {
          throw new DiscoveryValidationError(
            'corrupt-record',
            `Interrupted canonical installation has no safe recovery record: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    let serviceOptions: ReturnType<typeof installationOptions> | null = null;
    let lastOwnershipError: unknown;
    for (const candidate of ownershipCandidates) {
      const candidateOptions = installationOptions(options, candidate);
      try {
        await assertOwnedDefinition(candidate, candidateOptions, options);
        serviceOptions = candidateOptions;
        break;
      } catch (error) {
        lastOwnershipError = error;
      }
    }
    if (!serviceOptions) {
      throw lastOwnershipError;
    }
    const discovered: DiscoveredStartupServiceInstallation = {
      record,
      recordPath,
      paths: serviceOptions.paths,
      options: serviceOptions,
    };
    return discovered;
  } catch (error) {
    return invalidInstallation(namespaceDirectory, recordPath, error);
  }
}

export async function discoverStartupServiceInstallations(
  options: StartupServiceDiscoveryOptions,
): Promise<StartupServiceInstallationInventory> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const stateRoot = path.dirname(
    getStatePaths(CANONICAL_SERVICE_NAMESPACE, platform, environment).stateDirectory,
  );
  let entries;
  try {
    entries = await readdir(stateRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { canonical: null, legacy: [], invalid: [] };
    }
    throw error;
  }
  const discovered = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => discoverRecord(stateRoot, entry.name, options)),
  );
  const owned = discovered.filter(
    (installation): installation is DiscoveredStartupServiceInstallation =>
      installation !== null && 'record' in installation,
  );
  return {
    canonical: owned.find(({ record }) => record.namespace === CANONICAL_SERVICE_NAMESPACE) ?? null,
    legacy: owned
      .filter(({ record }) => record.namespace !== CANONICAL_SERVICE_NAMESPACE)
      .sort((left, right) => left.record.namespace.localeCompare(right.record.namespace)),
    invalid: discovered.filter(
      (installation): installation is InvalidStartupServiceInstallation =>
        installation !== null && !('record' in installation),
    ),
  };
}
