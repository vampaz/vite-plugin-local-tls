import type {
  DiscoveredStartupServiceInstallation,
  StartupServiceInstallationInventory,
} from './service-installation-inventory.js';
import type { ServiceState } from './service-state.js';
import type { ServiceStatus } from './service-status.js';
import type { StatePaths } from './state-paths.js';

export interface CanonicalServiceEnsureRequest {
  updateRequired: boolean;
  installService: () => Promise<void>;
}

export interface StartupServiceLifecycleOperations {
  canonicalNamespace: string;
  canonicalPaths: StatePaths;
  discover: () => Promise<StartupServiceInstallationInventory>;
  status: (installation: DiscoveredStartupServiceInstallation) => Promise<ServiceStatus>;
  ensureLegacy: (installation: DiscoveredStartupServiceInstallation) => Promise<ServiceState>;
  ensureCanonical: (request: CanonicalServiceEnsureRequest) => Promise<ServiceState>;
  converge: (
    installations: DiscoveredStartupServiceInstallation[],
    source?: DiscoveredStartupServiceInstallation,
  ) => Promise<void>;
}

export interface StartupServiceLifecycleResult {
  state: ServiceState;
  namespace: string;
  paths: StatePaths;
  adoptedLegacy: boolean;
  invalidInstallations: StartupServiceInstallationInventory['invalid'];
}
