import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeCommand } from './command-runner.js';
import type { CommandExecutionOptions } from './interfaces/command-execution-options.js';
import type {
  CommandResult,
  CommandRunner,
  TrustStoreOptions,
  TrustStoreStatus,
} from './interfaces/trust-store-options.js';

const COMMAND_TIMEOUT_MS = 30_000;
const INTERACTIVE_AUTHORIZATION_TIMEOUT_MS = 0;

function runCommand(
  command: string,
  arguments_: string[],
  timeoutMs: number,
  options?: CommandExecutionOptions,
): Promise<CommandResult> {
  return executeCommand(command, arguments_, { ...options, timeoutMs });
}

function normalizeFingerprint(value: string): string {
  return value.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
}

function pemFingerprints(output: string): string[] {
  return (
    output
      .match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)
      ?.flatMap((pem) => {
        try {
          return [normalizeFingerprint(new X509Certificate(pem).fingerprint256)];
        } catch {
          return [];
        }
      }) ?? []
  );
}

export class TrustStore {
  readonly #options: TrustStoreOptions;
  readonly #runner: CommandRunner;

  constructor(options: TrustStoreOptions) {
    this.#options = options;
    this.#runner = options.runner ?? runCommand;
  }

  async install(): Promise<TrustStoreStatus> {
    const { requirements } = this.#options;
    if (!requirements.trustToolPath || !requirements.trustTool) {
      throw new Error('No supported operating-system trust tool is available.');
    }
    if (requirements.platform === 'darwin') {
      await this.#run(
        requirements.trustToolPath,
        [
          'add-trusted-cert',
          '-r',
          'trustRoot',
          '-k',
          this.#macosKeychain(),
          this.#options.authority.certificatePath,
        ],
        undefined,
        INTERACTIVE_AUTHORIZATION_TIMEOUT_MS,
      );
    } else if (requirements.trustTool === 'certutil') {
      const certificatePath = requirements.isWsl
        ? await this.#windowsPath(this.#options.authority.certificatePath)
        : this.#options.authority.certificatePath;
      await this.#run(requirements.trustToolPath, ['-user', '-addstore', 'Root', certificatePath]);
    } else {
      await this.#installLinux();
    }
    const status = await this.verify();
    if (!status.trusted) {
      throw new Error(
        'The trust command completed, but the exact local CA fingerprint was not found.',
      );
    }
    return status;
  }

  async verify(): Promise<TrustStoreStatus> {
    const { requirements, authority } = this.#options;
    if (!requirements.trustToolPath || !requirements.trustTool) {
      return { trusted: false, fingerprint: authority.fingerprint, tool: 'unavailable' };
    }
    let trusted = false;
    if (requirements.platform === 'darwin') {
      const result = await this.#run(requirements.trustToolPath, [
        'find-certificate',
        '-a',
        '-p',
        this.#macosKeychain(),
      ]);
      trusted =
        pemFingerprints(result.stdout).includes(authority.fingerprint) &&
        (await this.#hasMacosTrustSettings());
    } else if (requirements.trustTool === 'certutil') {
      const result = await this.#run(requirements.trustToolPath, [
        '-user',
        '-store',
        'Root',
        authority.fingerprint,
      ]);
      trusted = normalizeFingerprint(result.stdout).includes(authority.fingerprint);
    } else if (requirements.trustTool === 'trust') {
      const result = await this.#run(requirements.trustToolPath, [
        'extract',
        '--format=pem-bundle',
        '--filter=ca-anchors',
        '--overwrite',
        '/dev/stdout',
      ]);
      trusted =
        pemFingerprints(result.stdout).includes(authority.fingerprint) ||
        normalizeFingerprint(result.stdout).includes(authority.fingerprint);
    } else {
      const target = this.#linuxTargetPath();
      try {
        const result = await this.#run(requirements.opensslPath ?? 'openssl', [
          'x509',
          '-in',
          target,
          '-noout',
          '-fingerprint',
          '-sha256',
        ]);
        trusted = normalizeFingerprint(result.stdout).includes(authority.fingerprint);
      } catch {
        trusted = false;
      }
    }
    return {
      trusted,
      fingerprint: authority.fingerprint,
      tool: requirements.trustTool,
    };
  }

  async remove(): Promise<TrustStoreStatus> {
    const { requirements, authority } = this.#options;
    if (!requirements.trustToolPath || !requirements.trustTool) {
      throw new Error('No supported operating-system trust tool is available.');
    }
    if (requirements.platform === 'darwin') {
      await this.#run(
        requirements.trustToolPath,
        [
          'delete-certificate',
          '-Z',
          authority.fingerprintSha1.toUpperCase(),
          this.#macosKeychain(),
        ],
        undefined,
        INTERACTIVE_AUTHORIZATION_TIMEOUT_MS,
      );
    } else if (requirements.trustTool === 'certutil') {
      await this.#run(requirements.trustToolPath, [
        '-user',
        '-delstore',
        'Root',
        authority.fingerprint,
      ]);
    } else {
      await this.#removeLinux();
    }
    const status = await this.verify();
    if (status.trusted) {
      throw new Error(
        'The exact local CA fingerprint is still trusted; retry `vite-local-tls untrust`.',
      );
    }
    return status;
  }

  async #installLinux(): Promise<void> {
    const tool = this.#options.requirements.trustTool;
    if (tool === 'trust') {
      await this.#runElevated(this.#options.requirements.trustToolPath!, [
        'anchor',
        '--store',
        this.#options.authority.certificatePath,
      ]);
      return;
    }
    const target = this.#linuxTargetPath();
    await this.#runElevated('install', [
      '-m',
      '0644',
      this.#options.authority.certificatePath,
      target,
    ]);
    await this.#runElevated(
      this.#options.requirements.trustToolPath!,
      this.#linuxRefreshArguments(),
    );
  }

  async #removeLinux(): Promise<void> {
    const tool = this.#options.requirements.trustTool;
    if (tool === 'trust') {
      await this.#runElevated(this.#options.requirements.trustToolPath!, [
        'anchor',
        '--remove',
        this.#options.authority.fingerprint,
      ]);
      return;
    }
    const target = this.#linuxTargetPath();
    await this.#runElevated('rm', ['-f', '--', target]);
    try {
      await this.#runElevated(
        this.#options.requirements.trustToolPath!,
        this.#linuxRefreshArguments(),
      );
    } catch (error) {
      throw new Error(
        `The CA file was removed from ${target}, but the trust store refresh failed. Retry \`vite-local-tls untrust\`.`,
        { cause: error },
      );
    }
  }

  #linuxTargetPath(): string {
    const suffix = this.#options.authority.fingerprint.slice(0, 12);
    return this.#options.requirements.trustTool === 'update-ca-certificates'
      ? `/usr/local/share/ca-certificates/vite-local-tls-${suffix}.crt`
      : `/etc/pki/ca-trust/source/anchors/vite-local-tls-${suffix}.pem`;
  }

  #linuxRefreshArguments(): string[] {
    return this.#options.requirements.trustTool === 'update-ca-trust' ? ['extract'] : [];
  }

  #macosKeychain(): string {
    return (
      this.#options.macosKeychain ??
      path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db')
    );
  }

  async #hasMacosTrustSettings(): Promise<boolean> {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-trust-'));
    const settingsPath = path.join(temporaryDirectory, 'trust-settings.plist');
    try {
      await this.#run(this.#options.requirements.trustToolPath!, [
        'trust-settings-export',
        settingsPath,
      ]);
      const settings = await readFile(settingsPath, 'utf8');
      const fingerprint = this.#options.authority.fingerprintSha1.toUpperCase();
      return new RegExp(`<key>\\s*${fingerprint}\\s*</key>`, 'i').test(settings);
    } catch {
      return false;
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async #windowsPath(filePath: string): Promise<string> {
    const result = await this.#run('wslpath', ['-w', filePath]);
    const windowsPath = result.stdout.trim();
    if (!windowsPath) {
      throw new Error(`Unable to convert ${filePath} to a Windows path.`);
    }
    return windowsPath;
  }

  #run(
    command: string,
    arguments_: string[],
    options?: CommandExecutionOptions,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<CommandResult> {
    return this.#runner(command, arguments_, timeoutMs, options);
  }

  #runElevated(command: string, arguments_: string[]): Promise<CommandResult> {
    if (this.#options.useSudo === false || process.getuid?.() === 0) {
      return this.#run(command, arguments_);
    }
    return this.#run('sudo', ['--', command, ...arguments_], { interactive: true });
  }
}
