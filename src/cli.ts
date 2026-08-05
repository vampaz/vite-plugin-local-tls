#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { readFile, rm, unlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CertificateImportStore } from './certificate-import.js';
import { CertificateManager } from './certificates.js';
import { SERVICE_BOOTSTRAP_HOSTNAME } from './daemon.js';
import type {
  CliActions,
  CliCertificateImportRequest,
  CliCertificateRequest,
  CliCleanRequest,
  CliContext,
  CliIo,
  CliProxyStartRequest,
  RunCliOptions,
} from './interfaces/cli-options.js';
import type { CertificateAuthorityRecord } from './interfaces/certificate-record.js';
import type { ServiceRuntimeConfiguration } from './interfaces/service-runtime-configuration.js';
import { LocalTlsService } from './service.js';
import { installStartupService, uninstallStartupService } from './service-install.js';
import { getStatePaths } from './state-paths.js';
import { inspectSystemRequirements } from './system-requirements.js';
import { TrustStore } from './trust-store.js';

const USAGE = `Usage: vite-local-tls <command> [options]

Commands:
  trust
  untrust
  cert import --hostname <host> --cert <path> --key <path> [--chain <path>]
  cert list
  cert remove --hostname <host>
  doctor
  proxy start|stop|status
  service install|uninstall
  clean [--ca]

Global options:
  --namespace <name>  Use an isolated service namespace (default: default)
  --control-socket <path>  Use an alternate private control socket or named pipe
  --help              Show this help
`;

function defaultIo(): CliIo {
  return {
    stdout(message): void {
      process.stdout.write(message);
    },
    stderr(message): void {
      process.stderr.write(message);
    },
  };
}

function takeOption(arguments_: string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = arguments_[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  if (arguments_.indexOf(name, index + 1) !== -1) {
    throw new Error(`${name} may only be provided once.`);
  }
  arguments_.splice(index, 2);
  return value;
}

function takeFlag(arguments_: string[], name: string): boolean {
  const index = arguments_.indexOf(name);
  if (index === -1) {
    return false;
  }
  arguments_.splice(index, 1);
  if (arguments_.includes(name)) {
    throw new Error(`${name} may only be provided once.`);
  }
  return true;
}

function requireOption(arguments_: string[], name: string): string {
  const value = takeOption(arguments_, name);
  if (!value) {
    throw new Error(`Missing required option ${name}.`);
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

async function readServiceRuntimeConfiguration(
  configurationPath: string,
): Promise<ServiceRuntimeConfiguration> {
  const value = JSON.parse(
    await readFile(configurationPath, 'utf8'),
  ) as Partial<ServiceRuntimeConfiguration>;
  const controlSocketIsValid =
    value.controlSocket === null ||
    (typeof value.controlSocket === 'string' &&
      value.controlSocket.length > 0 &&
      value.controlSocket.length <= 4096 &&
      !containsControlCharacter(value.controlSocket));
  if (
    value.version !== 1 ||
    value.owner !== '@vampaz/vite-plugin-local-tls' ||
    typeof value.namespace !== 'string' ||
    value.namespace.length === 0 ||
    value.namespace.length > 256 ||
    containsControlCharacter(value.namespace) ||
    !controlSocketIsValid
  ) {
    throw new Error('The local TLS service runtime configuration is invalid.');
  }
  return value as ServiceRuntimeConfiguration;
}

function takeIntegerOption(arguments_: string[], name: string): number | undefined {
  const value = takeOption(arguments_, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} requires a non-negative integer.`);
  }
  return parsed;
}

function requireNoArguments(arguments_: string[]): void {
  if (arguments_.length > 0) {
    throw new Error(`Unexpected argument: ${arguments_[0]}`);
  }
}

function writeResult(io: CliIo, result: unknown): void {
  if (result === undefined) {
    return;
  }
  io.stdout(`${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}\n`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createService(context: CliContext): LocalTlsService {
  const requirements = inspectSystemRequirements();
  if (!requirements.opensslPath) {
    throw new Error('OpenSSL is required. Install openssl and ensure it is on PATH.');
  }
  const runAsUser =
    context.runAsUid !== undefined && context.runAsGid !== undefined
      ? { uid: context.runAsUid, gid: context.runAsGid }
      : undefined;
  return new LocalTlsService({
    paths: resolvePaths(context),
    opensslPath: requirements.opensslPath,
    namespace: context.namespace,
    port: 443,
    ...(runAsUser ? { runAsUser } : {}),
  });
}

function resolvePaths(context: CliContext): ReturnType<typeof getStatePaths> {
  const paths = getStatePaths(context.namespace);
  return context.controlSocket ? { ...paths, socketPath: context.controlSocket } : paths;
}

async function readAuthority(context: CliContext): Promise<CertificateAuthorityRecord | null> {
  const paths = resolvePaths(context);
  try {
    return JSON.parse(await readFile(paths.caStatePath, 'utf8')) as CertificateAuthorityRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function createDefaultCliActions(): CliActions {
  let ownedService: LocalTlsService | null = null;

  async function trust(context: CliContext): Promise<unknown> {
    const requirements = inspectSystemRequirements();
    if (!requirements.opensslPath || !requirements.trustToolPath) {
      throw new Error(requirements.missing.join('\n'));
    }
    const paths = resolvePaths(context);
    const manager = new CertificateManager({ paths, opensslPath: requirements.opensslPath });
    const authority = await manager.ensureCertificateAuthority();
    return new TrustStore({ requirements, authority }).install();
  }

  async function untrust(context: CliContext): Promise<unknown> {
    const requirements = inspectSystemRequirements();
    const authority = await readAuthority(context);
    if (!authority) {
      return { trusted: false, message: 'No local certificate authority exists.' };
    }
    return new TrustStore({ requirements, authority }).remove();
  }

  async function certificateImport(request: CliCertificateImportRequest): Promise<unknown> {
    const store = new CertificateImportStore({ paths: resolvePaths(request) });
    return store.importCertificate({
      hostname: request.hostname,
      certificatePath: request.certificatePath,
      keyPath: request.keyPath,
      chainPath: request.chainPath,
    });
  }

  async function certificateList(context: CliContext): Promise<unknown> {
    return new CertificateImportStore({
      paths: resolvePaths(context),
    }).listCertificates();
  }

  async function certificateRemove(request: CliCertificateRequest): Promise<unknown> {
    const removed = await new CertificateImportStore({
      paths: resolvePaths(request),
    }).removeCertificate(request.hostname);
    return { hostname: request.hostname, removed };
  }

  async function doctor(context: CliContext): Promise<unknown> {
    const requirements = inspectSystemRequirements();
    const service = requirements.opensslPath ? await createService(context).status() : null;
    const authority = await readAuthority(context);
    const trust =
      authority && requirements.trustToolPath
        ? await new TrustStore({ requirements, authority }).verify()
        : null;
    return { requirements, service, authority, trust };
  }

  async function proxyStart(request: CliProxyStartRequest): Promise<unknown> {
    const service = createService(request);
    async function isTrusted(): Promise<boolean> {
      const requirements = inspectSystemRequirements();
      const authority = await readAuthority(request);
      if (!authority || !requirements.trustToolPath) {
        return false;
      }
      return (await new TrustStore({ requirements, authority }).verify()).trusted;
    }
    let state = request.serviceMode
      ? await service.ensureRunning()
      : await service.autoStart({
          isTrusted,
          async trust(): Promise<void> {
            await trust(request);
          },
          async installService(): Promise<void> {
            await serviceInstall(request);
          },
        });
    let stopping = false;
    ownedService = service.ownsStartedDaemon ? service : null;
    async function stopOwnedService(): Promise<void> {
      stopping = true;
      await ownedService?.stopStartedDaemon();
      ownedService = null;
    }
    process.once('SIGINT', () => void stopOwnedService());
    process.once('SIGTERM', () => void stopOwnedService());
    if (request.serviceMode) {
      while (!stopping && !service.ownsStartedDaemon) {
        await delay(500);
        if (!(await service.status()).running) {
          state = await service.ensureRunning();
          ownedService = service.ownsStartedDaemon ? service : null;
        }
      }
    }
    return state;
  }

  async function proxyStop(context: CliContext): Promise<unknown> {
    return { stopped: await createService(context).stopIfIdle() };
  }

  async function proxyStatus(context: CliContext): Promise<unknown> {
    return createService(context).status();
  }

  async function serviceInstall(context: CliContext): Promise<unknown> {
    const requirements = inspectSystemRequirements();
    if (!requirements.opensslPath) {
      throw new Error('OpenSSL is required. Install openssl and ensure it is on PATH.');
    }
    const manager = new CertificateManager({
      paths: resolvePaths(context),
      opensslPath: requirements.opensslPath,
      isHostnameRegistered: (hostname) => hostname === SERVICE_BOOTSTRAP_HOSTNAME,
    });
    await manager.ensureCertificateAuthority();
    await manager.ensureLeafCertificate(SERVICE_BOOTSTRAP_HOSTNAME);
    return installStartupService({
      namespace: context.namespace,
      paths: resolvePaths(context),
      nodePath: process.execPath,
      cliPath: fileURLToPath(new URL('./cli.js', import.meta.url)),
      controlSocket: context.controlSocket,
    });
  }

  async function serviceUninstall(context: CliContext): Promise<unknown> {
    return uninstallStartupService({
      namespace: context.namespace,
      paths: resolvePaths(context),
      nodePath: process.execPath,
      cliPath: fileURLToPath(new URL('./cli.js', import.meta.url)),
      controlSocket: context.controlSocket,
    });
  }

  async function clean(request: CliCleanRequest): Promise<unknown> {
    const paths = resolvePaths(request);
    const serviceStatus = await createService(request).status();
    if (serviceStatus.running) {
      throw new Error('Stop the local TLS proxy before cleaning its generated state.');
    }
    const removed = ['generated certificates'];
    await rm(paths.certificateDirectory, { recursive: true, force: true });
    await unlink(paths.stateFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
    if (request.removeAuthority) {
      const authority = await readAuthority(request);
      if (authority) {
        const requirements = inspectSystemRequirements();
        const status = await new TrustStore({ requirements, authority }).verify();
        if (status.trusted) {
          throw new Error('Run `vite-local-tls untrust` before `vite-local-tls clean --ca`.');
        }
      }
      await Promise.all(
        [paths.caKeyPath, paths.caCertificatePath, paths.caStatePath].map((filePath) =>
          unlink(filePath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') {
              throw error;
            }
          }),
        ),
      );
      removed.push('certificate authority');
    }
    return { removed };
  }

  return {
    trust,
    untrust,
    certificateImport,
    certificateList,
    certificateRemove,
    doctor,
    proxyStart,
    proxyStop,
    proxyStatus,
    serviceInstall,
    serviceUninstall,
    clean,
  };
}

async function dispatch(
  arguments_: string[],
  context: CliContext,
  actions: CliActions,
): Promise<unknown> {
  const command = arguments_.shift();
  if (command === 'trust') {
    requireNoArguments(arguments_);
    return actions.trust(context);
  }
  if (command === 'untrust') {
    requireNoArguments(arguments_);
    return actions.untrust(context);
  }
  if (command === 'doctor') {
    requireNoArguments(arguments_);
    return actions.doctor(context);
  }
  if (command === 'clean') {
    const removeAuthority = takeFlag(arguments_, '--ca');
    requireNoArguments(arguments_);
    return actions.clean({ ...context, removeAuthority });
  }
  const subcommand = arguments_.shift();
  if (command === 'cert' && subcommand === 'import') {
    const request: CliCertificateImportRequest = {
      ...context,
      hostname: requireOption(arguments_, '--hostname'),
      certificatePath: requireOption(arguments_, '--cert'),
      keyPath: requireOption(arguments_, '--key'),
    };
    const chainPath = takeOption(arguments_, '--chain');
    if (chainPath) {
      request.chainPath = chainPath;
    }
    requireNoArguments(arguments_);
    return actions.certificateImport(request);
  }
  if (command === 'cert' && subcommand === 'list') {
    requireNoArguments(arguments_);
    return actions.certificateList(context);
  }
  if (command === 'cert' && subcommand === 'remove') {
    const hostname = requireOption(arguments_, '--hostname');
    requireNoArguments(arguments_);
    return actions.certificateRemove({ ...context, hostname });
  }
  if (command === 'proxy' && subcommand === 'start') {
    const serviceMode = takeFlag(arguments_, '--service');
    requireNoArguments(arguments_);
    return actions.proxyStart({ ...context, serviceMode });
  }
  if (command === 'proxy' && subcommand === 'stop') {
    requireNoArguments(arguments_);
    return actions.proxyStop(context);
  }
  if (command === 'proxy' && subcommand === 'status') {
    requireNoArguments(arguments_);
    return actions.proxyStatus(context);
  }
  if (command === 'service' && subcommand === 'install') {
    requireNoArguments(arguments_);
    return actions.serviceInstall(context);
  }
  if (command === 'service' && subcommand === 'uninstall') {
    requireNoArguments(arguments_);
    return actions.serviceUninstall(context);
  }
  throw new Error(
    command
      ? `Unknown command: ${[command, subcommand].filter(Boolean).join(' ')}`
      : 'Missing command.',
  );
}

export async function runCli(
  arguments_ = process.argv.slice(2),
  options: RunCliOptions = {},
): Promise<number> {
  const io = options.io ?? defaultIo();
  const parsedArguments = [...arguments_];
  if (takeFlag(parsedArguments, '--help')) {
    io.stdout(USAGE);
    return 0;
  }
  try {
    const configurationPath = takeOption(parsedArguments, '--service-config');
    const namespaceOption = takeOption(parsedArguments, '--namespace');
    const controlSocket = takeOption(parsedArguments, '--control-socket');
    const runAsUid = takeIntegerOption(parsedArguments, '--run-as-uid');
    const runAsGid = takeIntegerOption(parsedArguments, '--run-as-gid');
    if ((runAsUid === undefined) !== (runAsGid === undefined)) {
      throw new Error('`--run-as-uid` and `--run-as-gid` must be provided together.');
    }
    if (
      configurationPath &&
      (namespaceOption ||
        controlSocket ||
        runAsUid !== undefined ||
        parsedArguments[0] !== 'proxy' ||
        parsedArguments[1] !== 'start' ||
        !parsedArguments.includes('--service'))
    ) {
      throw new Error('`--service-config` is reserved for the installed startup service.');
    }
    const configuration = configurationPath
      ? await readServiceRuntimeConfiguration(configurationPath)
      : null;
    const context: CliContext = {
      namespace: configuration?.namespace ?? namespaceOption ?? 'default',
    };
    if (configuration?.controlSocket) {
      context.controlSocket = configuration.controlSocket;
    }
    if (controlSocket) {
      context.controlSocket = controlSocket;
    }
    if (runAsUid !== undefined && runAsGid !== undefined) {
      context.runAsUid = runAsUid;
      context.runAsGid = runAsGid;
    }
    const result = await dispatch(
      parsedArguments,
      context,
      options.actions ?? createDefaultCliActions(),
    );
    writeResult(io, result);
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectExecution()) {
  void runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
