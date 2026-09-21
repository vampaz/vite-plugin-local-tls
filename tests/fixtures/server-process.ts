import { spawn, type ChildProcess } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CertificateManager } from '../../src/certificates.js';
import type { CertificateAuthorityRecord } from '../../src/interfaces/certificate-record.js';
import type { StatePaths } from '../../src/interfaces/state-paths.js';
import { ensurePersistentStatePaths, getStatePaths } from '../../src/state-paths.js';
import { findExecutable, inspectSystemRequirements } from '../../src/system-requirements.js';
import { TrustStore } from '../../src/trust-store.js';

export interface E2eContext {
  root: string;
  fixtureDirectory: string;
  stateHome: string;
  namespace: string;
  proxyPort: number;
  paths: ReturnType<typeof getStatePaths>;
  servers: Set<RunningServer>;
}

export interface E2eAuthority {
  paths: StatePaths;
  record: CertificateAuthorityRecord;
}

function e2eAuthorityCachePaths(): StatePaths {
  return getStatePaths('e2e-authority', process.platform, {
    ...process.env,
    HOME: path.join(os.homedir(), '.cache', 'vite-local-tls-e2e'),
  });
}

async function hasStoredAuthority(paths: StatePaths): Promise<boolean> {
  try {
    await Promise.all([readFile(paths.caCertificatePath), readFile(paths.caKeyPath)]);
    return true;
  } catch {
    return false;
  }
}

export async function verifyE2eAuthorityTrust(
  authority: CertificateAuthorityRecord,
): Promise<boolean> {
  const requirements = inspectSystemRequirements();
  return (await new TrustStore({ requirements, authority }).verify()).trusted;
}

async function importIntoBrowserNssStore(certificatePath: string): Promise<void> {
  if (process.platform !== 'linux') {
    return;
  }
  const certutil = findExecutable('certutil', process.env);
  if (!certutil) {
    return;
  }
  try {
    const databaseDirectory = path.join(os.homedir(), '.pki', 'nssdb');
    await mkdir(databaseDirectory, { recursive: true });
    const initialized = await access(path.join(databaseDirectory, 'cert9.db')).then(
      () => true,
      () => false,
    );
    if (!initialized) {
      await run(
        certutil,
        ['-N', '-d', `sql:${databaseDirectory}`, '--empty-password'],
        repositoryRoot,
      );
    }
    await run(
      certutil,
      [
        '-A',
        '-d',
        `sql:${databaseDirectory}`,
        '-n',
        'vite-local-tls-e2e',
        '-t',
        'C,,',
        '-i',
        certificatePath,
      ],
      repositoryRoot,
    );
  } catch {
    // Best effort: Chromium may still trust the operating-system store on Linux.
  }
}

export async function resolveE2eAuthority(options: {
  interactive: boolean;
}): Promise<E2eAuthority> {
  const requirements = inspectSystemRequirements();
  if (!requirements.opensslPath || !requirements.trustToolPath || !requirements.trustTool) {
    throw new Error(
      `The e2e suite requires openssl and a system trust tool: ${requirements.missing.join('; ')}`,
    );
  }
  const realPaths = getStatePaths('default', process.platform, process.env);
  if (await hasStoredAuthority(realPaths)) {
    try {
      const record = await new CertificateManager({
        paths: realPaths,
        opensslPath: requirements.opensslPath,
      }).ensureCertificateAuthority();
      if ((await new TrustStore({ requirements, authority: record }).verify()).trusted) {
        await importIntoBrowserNssStore(record.certificatePath);
        return { paths: realPaths, record };
      }
    } catch {
      // A broken or untrusted local authority falls back to the shared e2e authority.
    }
  }
  const paths = e2eAuthorityCachePaths();
  const record = await new CertificateManager({
    paths,
    opensslPath: requirements.opensslPath,
  }).ensureCertificateAuthority();
  const trustStore = new TrustStore({ requirements, authority: record });
  if (!(await trustStore.verify()).trusted) {
    if (!options.interactive && process.env.CI !== 'true') {
      throw new Error(
        'The shared e2e certificate authority is not trusted on this machine. Run `npm run test:e2e:setup` once to trust it (macOS shows an authorization prompt).',
      );
    }
    await trustStore.install();
  }
  await importIntoBrowserNssStore(record.certificatePath);
  return { paths, record };
}

async function seedE2eAuthority(paths: StatePaths, authority: E2eAuthority): Promise<void> {
  if (authority.record.certificatePath === paths.caCertificatePath) {
    return;
  }
  await ensurePersistentStatePaths(paths);
  await copyFile(authority.record.certificatePath, paths.caCertificatePath);
  await copyFile(authority.record.keyPath, paths.caKeyPath);
  if (process.platform !== 'win32') {
    await chmod(paths.caKeyPath, 0o600);
  }
}

export interface StartServerOptions {
  domains?: string[];
  expectedDomains?: string[];
  marker: string;
  checkout?: string;
  branch?: string;
  vitePort?: number;
  host?: string;
  mode?: 'dev' | 'preview';
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  expectedOutput?: RegExp;
  strictPort?: boolean;
}

export interface RunningServer {
  child: ChildProcess;
  domains: string[];
  marker: string;
  vitePort: number;
  output: () => string;
  stop: (signal?: NodeJS.Signals) => Promise<void>;
}

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

function run(
  command: string,
  arguments_: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout?.on('data', (chunk) => output.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(output).toString().trim());
      } else {
        reject(
          new Error(
            `${command} ${arguments_.join(' ')} exited with ${String(code)}:\n${Buffer.concat(errors).toString()}${Buffer.concat(output).toString()}`,
          ),
        );
      }
    });
  });
}

export function findAvailablePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to allocate a test port.'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function installPackedPlayground(root: string): Promise<string> {
  await run('npm', ['run', 'build'], repositoryRoot);
  const packOutput = await run(
    'npm',
    ['pack', '--json', '--pack-destination', root],
    repositoryRoot,
  );
  const packResult = JSON.parse(packOutput) as
    | Array<{ filename: string }>
    | Record<string, { filename: string }>;
  const packed = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
  if (!packed?.filename) {
    throw new Error(`npm pack did not return an artifact filename: ${packOutput}`);
  }
  const tarballPath = path.join(root, packed.filename);
  const fixtureDirectory = path.join(root, 'playground');
  await cp(path.join(repositoryRoot, 'playground'), fixtureDirectory, { recursive: true });
  await writeFile(
    path.join(fixtureDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'vite-local-tls-installed-e2e',
        version: '0.0.0',
        private: true,
        type: 'module',
        scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
        dependencies: {
          '@vampaz/vite-plugin-local-tls': `file:${tarballPath}`,
          vite: process.env.VITE_E2E_VITE_VERSION ?? '8.2.0',
        },
      },
      null,
      2,
    )}\n`,
  );
  await run('npm', ['install', '--ignore-scripts'], fixtureDirectory);
  return fixtureDirectory;
}

export async function prepareE2eContext(): Promise<E2eContext> {
  const parentDirectory = process.env.VITE_LOCAL_TLS_E2E_PARENT ?? os.tmpdir();
  await mkdir(parentDirectory, { recursive: true });
  const root = await mkdtemp(path.join(parentDirectory, 'vite-local-tls-e2e-'));
  const stateHome = path.join(root, 'home');
  const namespace = path.basename(root).slice(-6);
  const proxyPort = process.env.VITE_TLS_DEFAULT_PATH === 'true' ? 443 : await findAvailablePort();
  const fixtureDirectory = await installPackedPlayground(root);
  const environment = { ...process.env, HOME: stateHome };
  const paths = getStatePaths(namespace, process.platform, environment);
  const authority = await resolveE2eAuthority({ interactive: false });
  await seedE2eAuthority(paths, authority);
  return {
    root,
    fixtureDirectory,
    stateHome,
    namespace,
    proxyPort,
    paths,
    servers: new Set(),
  };
}

function waitForOutput(
  child: ChildProcess,
  output: () => string,
  pattern: RegExp,
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern}:\n${output()}`));
    }, timeoutMs);

    function inspect(): void {
      if (pattern.test(output())) {
        cleanup();
        resolve();
      }
    }

    function handleExit(code: number | null, signal: NodeJS.Signals | null): void {
      cleanup();
      reject(
        new Error(
          `Vite exited before readiness with code ${String(code)} and signal ${String(signal)}:\n${output()}`,
        ),
      );
    }

    function cleanup(): void {
      clearTimeout(timer);
      child.stdout?.off('data', inspect);
      child.stderr?.off('data', inspect);
      child.off('exit', handleExit);
    }

    child.stdout?.on('data', inspect);
    child.stderr?.on('data', inspect);
    child.once('exit', handleExit);
    inspect();
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.off('exit', handleExit);
      reject(new Error('Timed out waiting for the Vite process to exit.'));
    }, timeoutMs);
    function handleExit(): void {
      clearTimeout(timer);
      resolve();
    }
    child.once('exit', handleExit);
  });
}

export async function startServer(
  context: E2eContext,
  options: StartServerOptions,
): Promise<RunningServer> {
  const vitePort = options.vitePort ?? (await findAvailablePort(options.host));
  const cwd = options.cwd ?? context.fixtureDirectory;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.environment,
    HOME: context.stateHome,
    VITE_TLS_NAMESPACE: context.namespace,
    VITE_TLS_PROXY_PORT: String(context.proxyPort),
    VITE_FIXTURE_PORT: String(vitePort),
    VITE_FIXTURE_HOST: options.host ?? '127.0.0.1',
    VITE_FIXTURE_MARKER: options.marker,
    VITE_FIXTURE_CHECKOUT: options.checkout ?? options.marker,
    VITE_FIXTURE_BRANCH: options.branch ?? 'main',
  };
  if (options.domains) {
    environment.VITE_TLS_DOMAINS = options.domains.join(',');
  } else {
    delete environment.VITE_TLS_DOMAINS;
  }
  if (options.mode === 'preview') {
    await run('npm', ['run', 'build'], cwd, environment);
  }
  const viteEntry = path.join(context.fixtureDirectory, 'node_modules', 'vite', 'bin', 'vite.js');
  const arguments_ = options.mode === 'preview' ? [viteEntry, 'preview'] : [viteEntry];
  if (options.strictPort !== false) {
    arguments_.push('--strictPort');
  }
  let processOutput = '';
  const child = spawn(process.execPath, arguments_, {
    cwd,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => {
    processOutput += Buffer.from(chunk).toString();
  });
  child.stderr?.on('data', (chunk) => {
    processOutput += Buffer.from(chunk).toString();
  });
  const runningServer: RunningServer = {
    child,
    domains: options.domains ?? options.expectedDomains ?? [],
    marker: options.marker,
    vitePort,
    output: () => processOutput,
    async stop(signal = 'SIGTERM'): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) {
        context.servers.delete(runningServer);
        return;
      }
      child.kill(signal);
      try {
        await waitForExit(child);
      } catch (error) {
        child.kill('SIGKILL');
        await waitForExit(child).catch(() => undefined);
        throw error;
      } finally {
        context.servers.delete(runningServer);
      }
    },
  };
  context.servers.add(runningServer);
  try {
    await waitForOutput(child, runningServer.output, options.expectedOutput ?? /Local TLS URL:/);
    const upstreamMatches = [
      ...runningServer
        .output()
        .matchAll(/Local TLS upstream: http:\/\/(?:\[[^\]]+\]|[^:\s]+):(\d+)/g),
    ];
    const actualPort = Number(upstreamMatches.at(-1)?.[1]);
    if (Number.isInteger(actualPort) && actualPort > 0) {
      runningServer.vitePort = actualPort;
    }
  } catch (error) {
    await runningServer.stop('SIGKILL').catch(() => undefined);
    throw error;
  }
  return runningServer;
}

export async function disposeE2eContext(context: E2eContext): Promise<void> {
  await Promise.all([...context.servers].map((server) => server.stop().catch(() => undefined)));
  const canonicalPaths = getStatePaths('default', process.platform, {
    ...process.env,
    HOME: context.stateHome,
  });
  const removeCanonicalRuntime =
    process.platform !== 'win32' &&
    process.env.CI === 'true' &&
    process.env.VITE_TLS_DEFAULT_PATH === 'true' &&
    canonicalPaths.runtimeDirectory !== context.paths.runtimeDirectory;
  await Promise.all([
    rm(context.root, { recursive: true, force: true }),
    process.platform === 'win32'
      ? Promise.resolve()
      : rm(context.paths.runtimeDirectory, { recursive: true, force: true }),
    removeCanonicalRuntime
      ? rm(canonicalPaths.runtimeDirectory, { recursive: true, force: true })
      : Promise.resolve(),
  ]);
}

export async function readFixtureSource(context: E2eContext): Promise<string> {
  return readFile(path.join(context.fixtureDirectory, 'src', 'main.ts'), 'utf8');
}
