import type {
  ServiceInstallationRecord,
  ServiceInstallCommandRunner,
  ServiceInstallOptions,
} from './service-install-options.js';
import type { StatePaths } from './state-paths.js';

export interface DiscoveredStartupServiceInstallation {
  record: ServiceInstallationRecord;
  recordPath: string;
  paths: StatePaths;
  options: ServiceInstallOptions;
}

export type InvalidStartupServiceReason =
  | 'corrupt-record'
  | 'missing-definition'
  | 'unrelated-definition'
  | 'unsafe-record'
  | 'unsafe-target';

export interface InvalidStartupServiceInstallation {
  namespace: string;
  recordPath: string;
  reason: InvalidStartupServiceReason;
  message: string;
}

export interface StartupServiceInstallationInventory {
  canonical: DiscoveredStartupServiceInstallation | null;
  legacy: DiscoveredStartupServiceInstallation[];
  invalid: InvalidStartupServiceInstallation[];
}

export interface StartupServiceDiscoveryOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  definitionDirectory?: string;
  runtimeRootDirectory?: string;
  nodePath: string;
  cliPath: string;
  runner?: ServiceInstallCommandRunner;
  useSudo?: boolean;
}
