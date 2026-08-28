import type { DiscoveredStartupServiceInstallation } from './interfaces/service-installation-inventory.js';
import { CONTROL_PROTOCOL_VERSION } from './control-protocol.js';
import type {
  StartupServiceLifecycleOperations,
  StartupServiceLifecycleResult,
} from './interfaces/startup-service-lifecycle.js';
import type { ServiceStatus } from './interfaces/service-status.js';
import { PACKAGE_VERSION } from './package-version.js';
import { compareServiceVersions } from './service-version.js';

export class StartupServiceLifecycleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StartupServiceLifecycleError';
    this.code = code;
  }
}

interface InspectedLegacyInstallation {
  installation: DiscoveredStartupServiceInstallation;
  status: ServiceStatus;
}

function migrationCandidates(
  inventory: Awaited<ReturnType<StartupServiceLifecycleOperations['discover']>>,
): DiscoveredStartupServiceInstallation[] {
  return [
    ...(inventory.canonical?.record.controlSocket ? [inventory.canonical] : []),
    ...inventory.legacy,
  ];
}

async function inspectLegacyInstallations(
  installations: DiscoveredStartupServiceInstallation[],
  operations: StartupServiceLifecycleOperations,
): Promise<InspectedLegacyInstallation[]> {
  return Promise.all(
    installations.map(async (installation) => ({
      installation,
      status: await operations.status(installation),
    })),
  );
}

async function inspectCanonicalInstallation(
  inventory: Awaited<ReturnType<StartupServiceLifecycleOperations['discover']>>,
  operations: StartupServiceLifecycleOperations,
): Promise<InspectedLegacyInstallation | null> {
  if (!inventory.canonical || inventory.canonical.record.controlSocket) {
    return null;
  }
  return {
    installation: inventory.canonical,
    status: await operations.status(inventory.canonical),
  };
}

function activeInstallations(
  installations: InspectedLegacyInstallation[],
): InspectedLegacyInstallation[] {
  return installations.filter(({ status }) => status.running && status.activeRoutes > 0);
}

function assertOneCompatibleActiveInstallation(
  active: InspectedLegacyInstallation[],
): InspectedLegacyInstallation | null {
  if (active.length > 1) {
    throw new StartupServiceLifecycleError(
      'MULTIPLE_ACTIVE_SERVICES',
      'More than one owned local TLS service reports active routes. No service was changed; run `vite-local-tls doctor` for exact ownership details.',
    );
  }
  const winner = active[0];
  if (!winner) {
    return null;
  }
  if (!winner.status.compatible) {
    throw new StartupServiceLifecycleError(
      'INCOMPATIBLE_LEGACY_ROUTES',
      `Legacy local TLS service ${winner.installation.record.identifier} owns ${winner.status.activeRoutes} active route(s) with an incompatible protocol. Stop those Vite processes before migration.`,
    );
  }
  return winner;
}

function newerInstallations(
  installations: InspectedLegacyInstallation[],
): InspectedLegacyInstallation[] {
  return installations.filter(
    ({ installation }) =>
      installation.record.version === 2 &&
      installation.record.installationState === 'installed' &&
      compareServiceVersions(installation.record.packageVersion, PACKAGE_VERSION) === 1,
  );
}

function selectCompatibleNewerInstallation(
  installations: InspectedLegacyInstallation[],
): InspectedLegacyInstallation | null {
  const newer = newerInstallations(installations);
  for (const candidate of newer) {
    if (
      candidate.installation.record.version === 2 &&
      candidate.installation.record.protocolVersion !== candidate.status.protocolVersion &&
      candidate.status.running
    ) {
      throw new StartupServiceLifecycleError(
        'NEWER_SERVICE_STATE_MISMATCH',
        `Newer legacy local TLS service ${candidate.installation.record.identifier} does not match its recorded control protocol. No service was changed; update this project and run \`vite-local-tls doctor\`.`,
      );
    }
    if (
      candidate.installation.record.version === 2 &&
      candidate.installation.record.protocolVersion !== CONTROL_PROTOCOL_VERSION
    ) {
      throw new StartupServiceLifecycleError(
        'NEWER_SERVICE_INCOMPATIBLE',
        `Newer legacy local TLS service ${candidate.installation.record.identifier} requires control protocol ${candidate.installation.record.protocolVersion}. Update this project before using it; the installed service was left unchanged.`,
      );
    }
  }
  return (
    newer.sort((left, right) => {
      const comparison = compareServiceVersions(
        right.installation.record.version === 2
          ? right.installation.record.packageVersion
          : PACKAGE_VERSION,
        left.installation.record.version === 2
          ? left.installation.record.packageVersion
          : PACKAGE_VERSION,
      );
      if (comparison !== null && comparison !== 0) {
        return comparison;
      }
      return (
        right.installation.record.installedAt.localeCompare(left.installation.record.installedAt) ||
        right.installation.record.namespace.localeCompare(left.installation.record.namespace)
      );
    })[0] ?? null
  );
}

export function selectCompatibleNewerStartupService(
  installations: InspectedLegacyInstallation[],
): DiscoveredStartupServiceInstallation | null {
  return selectCompatibleNewerInstallation(installations)?.installation ?? null;
}

export async function ensureStartupServiceLifecycle(
  operations: StartupServiceLifecycleOperations,
): Promise<StartupServiceLifecycleResult> {
  const inventory = await operations.discover();
  const candidates = migrationCandidates(inventory);
  const [inspected, canonical] = await Promise.all([
    inspectLegacyInstallations(candidates, operations),
    inspectCanonicalInstallation(inventory, operations),
  ]);
  const active = assertOneCompatibleActiveInstallation(
    activeInstallations([...inspected, ...(canonical ? [canonical] : [])]),
  );
  if (active) {
    const adoptedLegacy =
      active.installation !== inventory.canonical ||
      Boolean(active.installation.record.controlSocket);
    return {
      state: await operations.ensureLegacy(active.installation),
      namespace: active.installation.record.namespace,
      paths: active.installation.paths,
      adoptedLegacy,
      invalidInstallations: inventory.invalid,
    };
  }
  selectCompatibleNewerInstallation(inspected);

  async function installService(): Promise<void> {
    const currentInventory = await operations.discover();
    if (currentInventory.invalid.length > 0) {
      throw new StartupServiceLifecycleError(
        'UNSAFE_STARTUP_SERVICE_INSTALLATIONS',
        `Refusing to change persistent local TLS services while ${currentInventory.invalid.length} installation record(s) cannot be verified. Run \`vite-local-tls doctor\` and inspect them before retrying.`,
      );
    }
    const currentInspected = await inspectLegacyInstallations(
      migrationCandidates(currentInventory),
      operations,
    );
    const currentCanonical = await inspectCanonicalInstallation(currentInventory, operations);
    const racingWinner = assertOneCompatibleActiveInstallation(
      activeInstallations([...currentInspected, ...(currentCanonical ? [currentCanonical] : [])]),
    );
    if (racingWinner) {
      if (
        racingWinner.installation === currentInventory.canonical &&
        !racingWinner.installation.record.controlSocket
      ) {
        return;
      }
      throw new StartupServiceLifecycleError(
        'LEGACY_ROUTES_ACTIVE',
        `Legacy local TLS service migration was cancelled because ${racingWinner.status.activeRoutes} route(s) became active. No service was changed; start this project again after those routes stop.`,
      );
    }
    const source = selectCompatibleNewerStartupService(currentInspected) ?? undefined;
    await operations.converge(currentInventory.legacy, source);
  }

  return {
    state: await operations.ensureCanonical({
      updateRequired: candidates.length > 0,
      installService,
    }),
    namespace: operations.canonicalNamespace,
    paths: operations.canonicalPaths,
    adoptedLegacy: false,
    invalidInstallations: inventory.invalid,
  };
}
