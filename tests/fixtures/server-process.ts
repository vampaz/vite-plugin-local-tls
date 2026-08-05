import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStatePaths } from '../../src/state-paths.js';

export interface E2eContext {
  root: string;
  fixtureDirectory: string;
  stateHome: string;
  namespace: string;
  proxyPort: number;
  paths: ReturnType<typeof getStatePaths>;
  servers: Set<RunningServer>;
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
  const proxyPort = await findAvailablePort();
  const fixtureDirectory = await installPackedPlayground(root);
  const environment = { ...process.env, HOME: stateHome };
  return {
    root,
    fixtureDirectory,
    stateHome,
    namespace,
    proxyPort,
    paths: getStatePaths(namespace, process.platform, environment),
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
  await rm(context.root, { recursive: true, force: true });
}

export async function readFixtureSource(context: E2eContext): Promise<string> {
  return readFile(path.join(context.fixtureDirectory, 'src', 'main.ts'), 'utf8');
}
