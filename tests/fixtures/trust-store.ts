import type { CertificateAuthorityRecord } from '../../src/interfaces/certificate-record.js';
import type { CommandResult, CommandRunner } from '../../src/interfaces/trust-store-options.js';

export type RecordedCommand = { command: string; arguments_: string[]; timeoutMs: number };

export function createAuthority(
  certificatePath: string,
  fingerprint = 'ab'.repeat(32),
): CertificateAuthorityRecord {
  return {
    certificatePath,
    keyPath: '/private/ca-key.pem',
    fingerprint,
    fingerprintSha1: 'cd'.repeat(20),
    validFrom: new Date(0).toISOString(),
    validTo: new Date(Date.now() + 100_000).toISOString(),
    expiresSoon: false,
  };
}

export function createRecordingRunner(
  handle: (command: string, arguments_: string[]) => CommandResult | Promise<CommandResult>,
): { calls: RecordedCommand[]; runner: CommandRunner } {
  const calls: RecordedCommand[] = [];
  async function runner(
    command: string,
    arguments_: string[],
    timeoutMs: number,
  ): Promise<CommandResult> {
    calls.push({ command, arguments_, timeoutMs });
    return handle(command, arguments_);
  }
  return { calls, runner };
}
