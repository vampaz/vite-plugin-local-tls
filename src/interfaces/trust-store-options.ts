import type { CertificateAuthorityRecord } from './certificate-record.js';
import type { SystemRequirements } from './system-requirements.js';

export type CommandResult = { stdout: string; stderr: string };
export type CommandRunner = (
  command: string,
  arguments_: string[],
  timeoutMs: number,
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
