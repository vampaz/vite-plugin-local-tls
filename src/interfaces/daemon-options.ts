import type { StatePaths } from './state-paths.js';

export interface DaemonOptions {
  paths: StatePaths;
  opensslPath: string;
  namespace?: string;
  port?: number;
}
