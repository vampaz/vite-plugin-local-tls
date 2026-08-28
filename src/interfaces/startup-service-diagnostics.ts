import type { InvalidStartupServiceInstallation } from './service-installation-inventory.js';
import type { StartupServiceUpdateStatus } from './service-install-options.js';
import type { ServiceStatus } from './service-status.js';

export interface StartupServiceDiagnosticEntry {
  role: 'canonical' | 'legacy';
  namespace: string;
  identifier: string;
  recordVersion: 1 | 2;
  packageVersion: string | null;
  recordedProtocolVersion: number | null;
  installationState: 'legacy' | 'installing' | 'installed';
  status: ServiceStatus | null;
  statusError: string | null;
}

export interface StartupServiceDiagnostics {
  canonicalNamespace: 'default';
  canonicalUpdateStatus: StartupServiceUpdateStatus;
  installations: StartupServiceDiagnosticEntry[];
  invalidInstallations: InvalidStartupServiceInstallation[];
  activeLegacyNamespace: string | null;
  repairRequired: boolean;
  repairCommand: string | null;
  message: string;
}
