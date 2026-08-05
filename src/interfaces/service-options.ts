import type { DaemonOptions } from './daemon-options.js';
import type { ServiceState } from './service-state.js';

export interface ServiceOptions extends DaemonOptions {
  startupTimeoutMs?: number;
  probeTimeoutMs?: number;
  retryDelayMs?: number;
  staleLockMs?: number;
  startDaemon?: () => Promise<ServiceState>;
}
