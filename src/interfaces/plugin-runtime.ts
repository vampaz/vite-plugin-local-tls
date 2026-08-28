import type { OwnedRouteInput } from '../control-client.js';
import type { ControlClientOptions } from './control-client-options.js';
import type { ServiceState } from './service-state.js';
import type { InvalidStartupServiceInstallation } from './service-installation-inventory.js';
import type { StatePaths } from './state-paths.js';

export interface PluginControlClient {
  readonly ownerToken: string;
  readonly claimedHostnames: string[];
  readonly connected: boolean;
  connect: () => Promise<void>;
  register: (routes: OwnedRouteInput[]) => Promise<string[]>;
  unregister: (hostnames?: string[]) => Promise<string[]>;
  heartbeat: (hostnames?: string[]) => Promise<string[]>;
  close: () => Promise<void>;
}

export interface PluginInfrastructureRequest {
  namespace: string;
  paths: StatePaths;
  controlSocket?: string;
}

export interface PluginLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string, error?: unknown) => void;
}

export interface PluginInfrastructureResult {
  state: ServiceState;
  namespace: string;
  paths: StatePaths;
  adoptedLegacy: boolean;
  invalidInstallations?: InvalidStartupServiceInstallation[];
}

export interface PluginRuntimeDependencies {
  platform: NodeJS.Platform;
  infrastructureMode?: 'canonical' | 'isolated';
  logger: PluginLogger;
  ensureInfrastructure: (
    request: PluginInfrastructureRequest,
  ) => Promise<ServiceState | PluginInfrastructureResult>;
  createControlClient: (options: ControlClientOptions) => PluginControlClient;
}
