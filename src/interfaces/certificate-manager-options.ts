import type { StatePaths } from './state-paths.js';

export interface CertificateManagerOptions {
  paths: StatePaths;
  opensslPath: string;
  now?: () => Date;
  isHostnameRegistered?: (hostname: string) => boolean;
}
