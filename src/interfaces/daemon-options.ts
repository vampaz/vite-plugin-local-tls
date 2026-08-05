import type { StatePaths } from './state-paths.js';
import type {
  DropServicePrivileges,
  ServiceUserIdentity,
  TransferServiceOwnership,
} from './service-user-identity.js';

export interface DaemonOptions {
  paths: StatePaths;
  opensslPath: string;
  namespace?: string;
  port?: number;
  runAsUser?: ServiceUserIdentity;
  transferOwnership?: TransferServiceOwnership;
  dropPrivileges?: DropServicePrivileges;
}
