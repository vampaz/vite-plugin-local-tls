import type { CertificateAuthorityRecord } from './certificate-record.js';
import type {
  CommandExecutionOptions,
  CommandExecutionResult,
} from './command-execution-options.js';
import type { SystemRequirements } from './system-requirements.js';

export type CommandResult = CommandExecutionResult;
export type CommandRunner = (
  command: string,
  arguments_: string[],
  timeoutMs: number,
  options?: CommandExecutionOptions,
) => Promise<CommandResult>;

export interface TrustStoreOptions {
  requirements: SystemRequirements;
  authority: CertificateAuthorityRecord;
  runner?: CommandRunner;
  macosKeychain?: string;
  useSudo?: boolean;
}

export interface TrustStoreStatus {
  trusted: boolean;
  fingerprint: string;
  tool: string;
}
