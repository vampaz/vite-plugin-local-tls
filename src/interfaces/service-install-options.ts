import type { StatePaths } from './state-paths.js';

export interface ServiceInstallCommandResult {
  stdout: string;
  stderr: string;
}

export type ServiceInstallCommandRunner = (
  command: string,
  arguments_: string[],
) => Promise<ServiceInstallCommandResult>;

export interface ServiceInstallOptions {
  platform?: NodeJS.Platform;
  namespace: string;
  paths: StatePaths;
  nodePath: string;
  cliPath: string;
  homeDirectory?: string;
  username?: string;
  uid?: number;
  runner?: ServiceInstallCommandRunner;
  useSudo?: boolean;
  definitionDirectory?: string;
}

export interface ServiceInstallationRecord {
  version: 1;
  platform: NodeJS.Platform;
  namespace: string;
  identifier: string;
  definitionPath: string | null;
  nodePath: string;
  cliPath: string;
  installedAt: string;
}

export interface ServiceInstallResult {
  installed: boolean;
  record: ServiceInstallationRecord | null;
}
