import type {
  CommandExecutionOptions,
  CommandExecutionResult,
} from './command-execution-options.js';
import type { StatePaths } from './state-paths.js';

export type ServiceInstallCommandResult = CommandExecutionResult;

export type ServiceInstallCommandRunner = (
  command: string,
  arguments_: string[],
  options?: CommandExecutionOptions,
) => Promise<ServiceInstallCommandResult>;

export interface ServiceInstallElevatedCommand {
  command: string;
  arguments_: string[];
  allowFailure?: boolean;
}

export interface ServiceInstallOptions {
  platform?: NodeJS.Platform;
  namespace: string;
  paths: StatePaths;
  nodePath: string;
  cliPath: string;
  homeDirectory?: string;
  username?: string;
  uid?: number;
  gid?: number;
  runner?: ServiceInstallCommandRunner;
  useSudo?: boolean;
  definitionDirectory?: string;
  runtimeInstallDirectory?: string;
  controlSocket?: string;
}

export interface ServiceInstallationRecord {
  version: 1;
  platform: NodeJS.Platform;
  namespace: string;
  identifier: string;
  definitionPath: string | null;
  nodePath: string;
  cliPath: string;
  runtimeDirectory?: string;
  controlSocket: string | null;
  installedAt: string;
}

export interface ServiceInstallResult {
  installed: boolean;
  record: ServiceInstallationRecord | null;
}
