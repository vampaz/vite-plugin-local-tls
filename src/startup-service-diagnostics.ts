import type {
  DiscoveredStartupServiceInstallation,
  StartupServiceInstallationInventory,
} from './interfaces/service-installation-inventory.js';
import type {
  StartupServiceDiagnosticEntry,
  StartupServiceDiagnostics,
} from './interfaces/startup-service-diagnostics.js';
import type { StartupServiceUpdateStatus } from './interfaces/service-install-options.js';
import type { ServiceStatus } from './interfaces/service-status.js';
import { CONTROL_PROTOCOL_VERSION } from './control-protocol.js';
import { PACKAGE_VERSION } from './package-version.js';
import { compareServiceVersions } from './service-version.js';

type StatusReader = (installation: DiscoveredStartupServiceInstallation) => Promise<ServiceStatus>;

async function diagnosticEntry(
  installation: DiscoveredStartupServiceInstallation,
  role: StartupServiceDiagnosticEntry['role'],
  readStatus: StatusReader,
): Promise<StartupServiceDiagnosticEntry> {
  try {
    return {
      role,
      namespace: installation.record.namespace,
      identifier: installation.record.identifier,
      recordVersion: installation.record.version,
      packageVersion: installation.record.version === 2 ? installation.record.packageVersion : null,
      recordedProtocolVersion:
        installation.record.version === 2 ? installation.record.protocolVersion : null,
      installationState:
        installation.record.version === 2 ? installation.record.installationState : 'legacy',
      status: await readStatus(installation),
      statusError: null,
    };
  } catch (error) {
    return {
      role,
      namespace: installation.record.namespace,
      identifier: installation.record.identifier,
      recordVersion: installation.record.version,
      packageVersion: installation.record.version === 2 ? installation.record.packageVersion : null,
      recordedProtocolVersion:
        installation.record.version === 2 ? installation.record.protocolVersion : null,
      installationState:
        installation.record.version === 2 ? installation.record.installationState : 'legacy',
      status: null,
      statusError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function diagnoseStartupServices(
  inventory: StartupServiceInstallationInventory,
  readStatus: StatusReader,
  canonicalUpdateStatus: StartupServiceUpdateStatus,
): Promise<StartupServiceDiagnostics> {
  const installations = await Promise.all([
    ...(inventory.canonical ? [diagnosticEntry(inventory.canonical, 'canonical', readStatus)] : []),
    ...inventory.legacy.map((installation) => diagnosticEntry(installation, 'legacy', readStatus)),
  ]);
  const activeLegacy = installations.find(
    ({ role, status }) => role === 'legacy' && status?.running && status.activeRoutes > 0,
  );
  const activeLegacyRoutes = installations
    .filter(({ role }) => role === 'legacy')
    .reduce((total, { status }) => total + (status?.activeRoutes ?? 0), 0);
  const canonicalRepairable =
    inventory.canonical !== null &&
    ['installing', 'legacy', 'modified', 'outdated'].includes(canonicalUpdateStatus);
  const canonicalActiveRoutes = canonicalRepairable
    ? (installations.find(({ role }) => role === 'canonical')?.status?.activeRoutes ?? 0)
    : 0;
  const repairable = inventory.legacy.length > 0 || canonicalRepairable;
  const newerLegacy = installations.filter(
    ({ role, recordVersion, packageVersion, installationState }) =>
      role === 'legacy' &&
      recordVersion === 2 &&
      installationState === 'installed' &&
      packageVersion !== null &&
      compareServiceVersions(packageVersion, PACKAGE_VERSION) === 1,
  );
  const newerLegacyStateMismatch = newerLegacy.some(
    ({ recordedProtocolVersion, status }) =>
      status?.running && recordedProtocolVersion !== status.protocolVersion,
  );
  const newerLegacyIncompatible = newerLegacy.some(
    ({ recordedProtocolVersion }) => recordedProtocolVersion !== CONTROL_PROTOCOL_VERSION,
  );
  const repairStatusesKnown = installations
    .filter(({ role }) => role === 'legacy' || (role === 'canonical' && canonicalRepairable))
    .every(({ status }) => status !== null);
  const repairRequired =
    repairable || canonicalUpdateStatus === 'newer-incompatible' || inventory.invalid.length > 0;
  const repairCommand =
    inventory.invalid.length === 0 &&
    repairable &&
    repairStatusesKnown &&
    !newerLegacyStateMismatch &&
    !newerLegacyIncompatible &&
    activeLegacyRoutes === 0 &&
    canonicalActiveRoutes === 0
      ? 'npm exec -- vite-local-tls service install'
      : null;
  const message =
    inventory.invalid.length > 0
      ? 'Unsafe or incomplete installation records need manual inspection; no persistent service will be changed while an unverified target remains.'
      : newerLegacyStateMismatch
        ? 'A newer legacy startup service does not match its recorded control protocol. Stop its active routes, update this project, and inspect it again before migration.'
        : newerLegacyIncompatible
          ? 'A newer legacy startup service requires a newer control protocol. Update this project; its installed runtime will not be downgraded.'
          : activeLegacyRoutes
            ? `Stop the ${activeLegacyRoutes} active legacy route(s), then start any project using the plugin to migrate safely.`
            : canonicalActiveRoutes
              ? `Stop the ${canonicalActiveRoutes} active canonical route(s), then start any updated project to repair the startup service safely.`
              : canonicalUpdateStatus === 'newer-incompatible'
                ? 'The canonical startup service requires a newer control protocol. Update this project; the newer installed runtime will not be downgraded.'
                : inventory.legacy.length > 0
                  ? 'Owned legacy startup services are idle and can be converged safely with the repair command.'
                  : canonicalRepairable
                    ? 'The canonical startup service is idle and can be repaired safely with the repair command.'
                    : inventory.canonical
                      ? 'Exactly one canonical startup-service identity is configured.'
                      : 'No persistent startup service is installed. The plugin will start one on demand when the platform requires it.';
  return {
    canonicalNamespace: 'default',
    canonicalUpdateStatus,
    installations,
    invalidInstallations: inventory.invalid,
    activeLegacyNamespace: activeLegacy?.namespace ?? null,
    repairRequired,
    repairCommand,
    message,
  };
}
