import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const packageName = '@vampaz/vite-plugin-local-tls';

function run(command, arguments_, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = [];
    const errors = [];
    child.stdout.on('data', (chunk) => output.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('exit', (code) => {
      const stdout = Buffer.concat(output).toString();
      const stderr = Buffer.concat(errors).toString();
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${arguments_.join(' ')} failed:\n${stderr}${stdout}`));
    });
  });
}

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function verifyInstalledPackage(temporaryDirectory, tarballPath) {
  await writeFile(
    path.join(temporaryDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'vite-local-tls-package-fixture',
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies: {
          '@types/node': '26.1.2',
          [packageName]: `file:${tarballPath}`,
          vite: '8.2.0',
        },
      },
      null,
      2,
    )}\n`,
  );
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], temporaryDirectory);

  const installedRoot = path.join(temporaryDirectory, 'node_modules', packageName);
  const installedManifest = JSON.parse(
    await readFile(path.join(installedRoot, 'package.json'), 'utf8'),
  );
  requireValue(installedManifest.name === packageName, 'The installed package name is incorrect.');
  requireValue(
    installedManifest.bin?.['vite-local-tls'] === 'dist/cli.js',
    'The installed CLI entry point is incorrect.',
  );
  requireValue(installedManifest.exports?.['.'], 'The root package export is missing.');
  requireValue(installedManifest.exports?.['./testing'], 'The testing package export is missing.');

  const importCheck = await run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const value = await import('${packageName}');
if (typeof value.default !== 'function' || typeof value.viteLocalTlsPlugin !== 'function') process.exit(1);
if (typeof value.resolveLocalTlsDomains !== 'function' || typeof value.resolveLocalTlsUrl !== 'function') process.exit(1);
if (typeof value.resolveCaddyTlsDomains !== 'function' || typeof value.resolveCaddyTlsUrl !== 'function') process.exit(1);
if (typeof (await import('${packageName}/testing')).LocalTlsService !== 'function') process.exit(1);
console.log('exports-ok');`,
    ],
    temporaryDirectory,
  );
  requireValue(importCheck.stdout.trim() === 'exports-ok', 'Installed exports did not load.');

  const detachedAuthorizationCheck = await run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import path from 'node:path';
delete process.env.CI;
Object.defineProperty(process, 'platform', { value: 'darwin' });
if (process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY) process.exit(1);
const { LocalTlsService } = await import('${packageName}/testing');
const directory = path.join(process.cwd(), 'detached-authorization');
const state = {
  version: 1,
  pid: 123,
  namespace: 'test',
  socketPath: path.join(directory, 'runtime', 'control.sock'),
  startedAt: '2026-01-01T00:00:00.000Z',
  protocolVersion: 1,
  port: 443,
  caFingerprint: 'fingerprint',
};
const service = new LocalTlsService({
  namespace: 'test',
  opensslPath: 'openssl',
  paths: {
    stateDirectory: path.join(directory, 'state'),
    runtimeDirectory: path.join(directory, 'runtime'),
    socketPath: state.socketPath,
    lockPath: path.join(directory, 'runtime', 'startup.lock'),
    stateFile: path.join(directory, 'state', 'service.json'),
    certificateDirectory: path.join(directory, 'state', 'certificates'),
    importedCertificateDirectory: path.join(directory, 'state', 'imported'),
    caKeyPath: path.join(directory, 'state', 'ca-key.pem'),
    caCertificatePath: path.join(directory, 'state', 'ca.pem'),
    caStatePath: path.join(directory, 'state', 'ca.json'),
  },
});
service.ensureRunning = async function ensureRunning() {
  throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
};
service.status = async function status() {
  return { running: true, activeRoutes: 0, protocolVersion: 1, compatible: true, state };
};
let installCalls = 0;
const result = await service.autoStart({
  isTrusted: async () => true,
  trust: async () => undefined,
  installService: async () => {
    installCalls += 1;
  },
});
if (result !== state || installCalls !== 1) process.exit(1);
installCalls = 0;
const updateResult = await service.autoStart({
  isTrusted: async () => true,
  trust: async () => undefined,
  isServiceCurrent: async () => false,
  installService: async () => {
    installCalls += 1;
  },
});
if (updateResult !== state || installCalls !== 1) process.exit(1);
console.log('detached-authorization-ok');`,
    ],
    temporaryDirectory,
  );
  requireValue(
    detachedAuthorizationCheck.stdout.trim() === 'detached-authorization-ok',
    'Installed package blocked macOS authorization without terminal streams.',
  );

  const cliPath = path.join(
    temporaryDirectory,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'vite-local-tls.cmd' : 'vite-local-tls',
  );
  const cli = await run(cliPath, ['--help'], temporaryDirectory);
  requireValue(cli.stdout.includes('Usage: vite-local-tls'), 'The installed CLI did not run.');

  await writeFile(
    path.join(temporaryDirectory, 'index.ts'),
    `import localTls, {
  resolveCaddyTlsDomains,
  resolveLocalTlsDomains,
  type LocalTlsPluginOptions,
  type ViteCaddyTlsPluginOptions,
} from '${packageName}';

const options: LocalTlsPluginOptions = { domain: 'types.localhost' };
const legacyOptions: ViteCaddyTlsPluginOptions = { domain: 'legacy.localhost' };
localTls(options);
resolveLocalTlsDomains(options);
resolveCaddyTlsDomains(legacyOptions);
`,
  );
  await writeFile(
    path.join(temporaryDirectory, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ESNext',
          types: ['node'],
          noEmit: true,
          strict: true,
        },
        include: ['index.ts'],
      },
      null,
      2,
    )}\n`,
  );
  await run(
    process.execPath,
    [path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc')],
    temporaryDirectory,
  );
}

async function verifyPackage() {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-tls-package-'));
  try {
    const packageManifest = JSON.parse(
      await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
    );
    const packResult = await run(
      'npm',
      ['pack', '--json', '--pack-destination', temporaryDirectory],
      repositoryRoot,
    );
    const records = JSON.parse(packResult.stdout);
    const record = Array.isArray(records) ? records[0] : Object.values(records)[0];
    requireValue(record?.filename, 'npm pack did not return a tarball filename.');
    const paths = new Set((record.files ?? []).map(({ path: filePath }) => filePath));
    for (const requiredPath of [
      'CHANGELOG.md',
      'CONTRIBUTING.md',
      'LICENSE',
      'MIGRATION.md',
      'README.md',
      'RELEASING.md',
      'SECURITY.md',
      'dist/cli.d.ts',
      'dist/cli.js',
      'dist/index.d.ts',
      'dist/index.js',
      'dist/testing.d.ts',
      'dist/testing.js',
      'package.json',
    ]) {
      requireValue(paths.has(requiredPath), `Packed artifact is missing ${requiredPath}.`);
    }
    requireValue(record.name === packageName, 'npm pack returned the wrong package name.');
    requireValue(
      record.version === packageManifest.version,
      'npm pack returned the wrong package version.',
    );
    await verifyInstalledPackage(
      temporaryDirectory,
      path.join(temporaryDirectory, record.filename),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await verifyPackage();
console.log('Verified packed files, installed exports, declarations, and CLI entry point.');
