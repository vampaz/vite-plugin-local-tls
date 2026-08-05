import type { ServiceState } from './service-state.js';

export interface ServiceStatus {
  running: boolean;
  activeRoutes: number;
  protocolVersion: number | null;
  compatible: boolean;
  state: ServiceState | null;
}
