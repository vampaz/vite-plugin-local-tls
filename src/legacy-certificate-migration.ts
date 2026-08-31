import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CertificateImportStore } from './certificate-import.js';
import { CertificateManager } from './certificates.js';
import type { CertificateAuthorityRecord } from './interfaces/certificate-record.js';
import type { DiscoveredStartupServiceInstallation } from './interfaces/service-installation-inventory.js';
import type { StatePaths } from './interfaces/state-paths.js';
import { ensurePersistentStatePaths } from './state-paths.js';

const MIGRATION_LOCK_TIMEOUT_MS = 30_000;
const MIGRATION_LOCK_STALE_MS = 30_000;
const MIGRATION_RETRY_MS = 25;
const BOOT_TIME_TOLERANCE_MS = 1_000;

interface AuthorityMigrationMarker {
  version: 1;
  sourceNamespace: string;
}

interface MigrationLock {
  pid: number;
  startedAt: string;
}

export interface LegacyCertificateMigrationOptions {
  canonicalPaths: StatePaths;
  legacyInstallations: DiscoveredStartupServiceInstallation[];
  opensslPath: string;
  isAuthorityTrusted?: (
    authority: CertificateAuthorityRecord,
    installation: DiscoveredStartupServiceInstallation,
  ) => Promise<boolean>;
}

export interface LegacyCertificateMigrationResult {
  authorityNamespace: string | null;
  importedHostnames: string[];
  conflicts: string[];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    const details = await lstat(filePath);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error(`Refusing unsafe certificate-state path: ${filePath}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function clearStaleLock(lockPath: string): Promise<void> {
  try {
    const [contents, details] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
    let lock: MigrationLock | null = null;
    try {
      const value = JSON.parse(contents) as Partial<MigrationLock>;
      if (
        Number.isSafeInteger(value.pid) &&
        Number(value.pid) > 0 &&
        typeof value.startedAt === 'string' &&
        Number.isFinite(Date.parse(value.startedAt))
      ) {
        lock = value as MigrationLock;
      }
    } catch {
      lock = null;
    }
    const pid = lock?.pid ?? Number(contents.trim());
    const validPid = Number.isSafeInteger(pid) && pid > 0;
    const bootBoundary = Date.now() - os.uptime() * 1_000 - BOOT_TIME_TOLERANCE_MS;
    const predatesBoot = lock
      ? Date.parse(lock.startedAt) < bootBoundary
      : details.mtimeMs < bootBoundary;
    if (
      predatesBoot ||
      (validPid && !isProcessRunning(pid)) ||
      (!validPid && Date.now() - details.mtimeMs >= MIGRATION_LOCK_STALE_MS)
    ) {
      await unlink(lockPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

async function withMigrationLock<T>(paths: StatePaths, operation: () => Promise<T>): Promise<T> {
  await ensurePersistentStatePaths(paths);
  const lockPath = path.join(paths.stateDirectory, 'ca-migration.lock');
  const deadline = Date.now() + MIGRATION_LOCK_TIMEOUT_MS;
  while (true) {
    const handle = await open(lockPath, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') {
        return null;
      }
      throw error;
    });
    if (handle) {
      try {
        const lock: MigrationLock = {
          pid: process.pid,
          startedAt: new Date().toISOString(),
        };
        await handle.writeFile(`${JSON.stringify(lock)}\n`);
        return await operation();
      } finally {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
      }
    }
    await clearStaleLock(lockPath);
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for certificate migration at ${lockPath}.`);
    }
    await delay(MIGRATION_RETRY_MS);
  }
}

async function readMarker(markerPath: string): Promise<AuthorityMigrationMarker | null> {
  try {
    const value = JSON.parse(
      await readFile(markerPath, 'utf8'),
    ) as Partial<AuthorityMigrationMarker>;
    if (value.version !== 1 || typeof value.sourceNamespace !== 'string') {
      throw new Error('The local TLS authority migration marker is invalid.');
    }
    return value as AuthorityMigrationMarker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function hasCompleteAuthority(paths: StatePaths): Promise<boolean> {
  const [certificate, key] = await Promise.all([
    pathExists(paths.caCertificatePath),
    pathExists(paths.caKeyPath),
  ]);
  return certificate && key;
}

async function selectAuthoritySource(
  options: LegacyCertificateMigrationOptions,
  marker: AuthorityMigrationMarker | null,
): Promise<DiscoveredStartupServiceInstallation | null> {
  const candidates = [...options.legacyInstallations].sort((left, right) =>
    right.record.installedAt.localeCompare(left.record.installedAt),
  );
  const selected = marker
    ? candidates.filter(({ record }) => record.namespace === marker.sourceNamespace)
    : candidates;
  let firstValidated: DiscoveredStartupServiceInstallation | null = null;
  for (const installation of selected) {
    if (!(await hasCompleteAuthority(installation.paths))) {
      continue;
    }
    try {
      const authority = await new CertificateManager({
        paths: installation.paths,
        opensslPath: options.opensslPath,
      }).ensureCertificateAuthority();
      firstValidated ??= installation;
      if (
        marker ||
        !options.isAuthorityTrusted ||
        (await options.isAuthorityTrusted(authority, installation).catch(() => false))
      ) {
        return installation;
      }
    } catch {
      continue;
    }
  }
  if (marker) {
    throw new Error(
      `Cannot resume local TLS authority migration from ${marker.sourceNamespace}; its complete validated authority is unavailable.`,
    );
  }
  return firstValidated;
}

async function copyMissingAuthorityFile(sourcePath: string, targetPath: string): Promise<void> {
  if (await pathExists(targetPath)) {
    return;
  }
  const temporaryPath = `${targetPath}.${process.pid}.migration`;
  await writeFile(temporaryPath, await readFile(sourcePath), {
    mode: targetPath.endsWith('ca-key.pem') ? 0o600 : 0o644,
  });
  await rename(temporaryPath, targetPath);
}

async function writeAuthorityMigrationMarker(
  markerPath: string,
  marker: AuthorityMigrationMarker,
): Promise<void> {
  const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
    await rename(temporaryPath, markerPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function migrateAuthority(
  options: LegacyCertificateMigrationOptions,
): Promise<string | null> {
  const markerPath = path.join(options.canonicalPaths.stateDirectory, 'ca-migration.json');
  const marker = await readMarker(markerPath);
  if ((await hasCompleteAuthority(options.canonicalPaths)) && !marker) {
    return null;
  }
  const source = await selectAuthoritySource(options, marker);
  if (!source) {
    const targetCertificateExists = await pathExists(options.canonicalPaths.caCertificatePath);
    const targetKeyExists = await pathExists(options.canonicalPaths.caKeyPath);
    if (targetCertificateExists !== targetKeyExists) {
      throw new Error(
        'The canonical local TLS authority is incomplete and no verified migration is in progress.',
      );
    }
    return null;
  }
  if (!marker) {
    await writeAuthorityMigrationMarker(markerPath, {
      version: 1,
      sourceNamespace: source.record.namespace,
    });
  }
  await copyMissingAuthorityFile(source.paths.caKeyPath, options.canonicalPaths.caKeyPath);
  await copyMissingAuthorityFile(
    source.paths.caCertificatePath,
    options.canonicalPaths.caCertificatePath,
  );
  await new CertificateManager({
    paths: options.canonicalPaths,
    opensslPath: options.opensslPath,
  }).ensureCertificateAuthority();
  await unlink(markerPath);
  return source.record.namespace;
}

async function migrateImports(
  options: LegacyCertificateMigrationOptions,
): Promise<Pick<LegacyCertificateMigrationResult, 'conflicts' | 'importedHostnames'>> {
  const canonicalStore = new CertificateImportStore({ paths: options.canonicalPaths });
  const importedHostnames = new Set<string>();
  const conflicts = new Set<string>();
  const installations = [...options.legacyInstallations].sort((left, right) =>
    right.record.installedAt.localeCompare(left.record.installedAt),
  );
  for (const installation of installations) {
    const legacyStore = new CertificateImportStore({ paths: installation.paths });
    for (const record of await legacyStore.listCertificates()) {
      const current = await canonicalStore.getCertificate(record.hostname);
      if (current) {
        if (current.fingerprint !== record.fingerprint) {
          conflicts.add(record.hostname);
        }
        continue;
      }
      await canonicalStore.importCertificate({
        hostname: record.hostname,
        certificatePath: record.certificatePath,
        keyPath: record.keyPath,
        chainPath: record.chainPath,
      });
      importedHostnames.add(record.hostname);
    }
  }
  return {
    importedHostnames: [...importedHostnames].sort(),
    conflicts: [...conflicts].sort(),
  };
}

export async function migrateLegacyCertificateState(
  options: LegacyCertificateMigrationOptions,
): Promise<LegacyCertificateMigrationResult> {
  return withMigrationLock(options.canonicalPaths, async () => {
    const authorityNamespace = await migrateAuthority(options);
    const imports = await migrateImports(options);
    return { authorityNamespace, ...imports };
  });
}
