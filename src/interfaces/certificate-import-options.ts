import type { StatePaths } from './state-paths.js';

export interface CertificateImportStoreOptions {
  paths: StatePaths;
  now?: () => Date;
}

export interface CertificateImportOptions {
  hostname: string;
  certificatePath: string;
  keyPath: string;
  chainPath?: string;
}
