import { spawn } from 'node:child_process';
import { access, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { connect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { getStatePaths } from '../dist/testing.js';

if (process.env.CI !== 'true' || process.env.VITE_LOCAL_TLS_DISPOSABLE_SERVICE_SMOKE !== 'true') {
  throw new Error(
    'This destructive startup-service smoke test may run only on its explicitly disposable CI host.',
  );
}

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = path.join(repositoryRoot, 'dist', 'cli.js');
const namespace = 'default';

function runCli(arguments_, interactive = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...arguments_], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    const output = [];
    const errors = [];
    child.stdout?.on('data', (chunk) => output.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('exit', (code) => {
      const stdout = Buffer.concat(output).toString();
      const stderr = Buffer.concat(errors).toString();
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`vite-local-tls ${arguments_.join(' ')} failed:\n${stderr}${stdout}`));
      }
    });
  });
}

function capture(command, arguments_) {
  return new Promise((resolve) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      killSignal: 'SIGKILL',
    });
    const output = [];
    const errors = [];
    child.stdout.on('data', (chunk) => output.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    child.once('error', (error) => resolve(String(error)));
    child.once('exit', (code) => {
      resolve(
        `${command} ${arguments_.join(' ')} exited ${String(code)}:\n${Buffer.concat(output).toString()}${Buffer.concat(errors).toString()}`,
      );
    });
  });
}

async function serviceDiagnostics() {
  if (process.platform === 'linux') {
    return Promise.all([
      capture('sudo', [
        '--',
        'systemctl',
        'status',
        '--no-pager',
        `vite-local-tls-${namespace}.service`,
      ]),
      capture('sudo', [
        '--',
        'journalctl',
        '--no-pager',
        '-n',
        '100',
        '-u',
        `vite-local-tls-${namespace}.service`,
      ]),
    ]);
  }
  if (process.platform === 'darwin') {
    const paths = getStatePaths(namespace);
    const [launchctl, stdout, stderr] = await Promise.all([
      capture('sudo', [
        '--',
        'launchctl',
        'print',
        `system/com.vampaz.vite-local-tls.${namespace}`,
      ]),
      readFile(path.join(paths.stateDirectory, 'service.log'), 'utf8').catch(String),
      readFile(path.join(paths.stateDirectory, 'service-error.log'), 'utf8').catch(String),
    ]);
    return [launchctl, `service.log:\n${stdout}`, `service-error.log:\n${stderr}`];
  }
  return [await capture('schtasks.exe', ['/Query', '/TN', `Vite Local TLS\\${namespace}`, '/V'])];
}

function parseStatus(output) {
  const status = JSON.parse(output);
  if (!status || typeof status !== 'object') {
    throw new Error(`Invalid service status: ${output}`);
  }
  return status;
}

function assertHealthyDoctor(output) {
  const doctor = JSON.parse(output);
  const startupService = doctor?.startupService;
  const canonical = startupService?.installations?.filter(
    (installation) => installation.role === 'canonical',
  );
  if (
    !doctor ||
    !Array.isArray(doctor.errors) ||
    doctor.errors.some((error) => error.check === 'startupService') ||
    !startupService ||
    !Array.isArray(startupService.invalidInstallations) ||
    startupService.invalidInstallations.length > 0 ||
    !Array.isArray(canonical) ||
    canonical.length !== 1 ||
    canonical[0].namespace !== 'default' ||
    canonical[0].status?.running !== true ||
    canonical[0].status?.compatible !== true ||
    startupService.canonicalUpdateStatus !== 'current'
  ) {
    throw new Error(`Installed service failed doctor validation: ${output}`);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function commandSucceeds(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'ignore',
      timeout: 15_000,
      killSignal: 'SIGKILL',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${arguments_.join(' ')} was terminated by ${signal}.`));
        return;
      }
      resolve(code === 0);
    });
  });
}

function runRequiredCommand(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'inherit',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `${command} ${arguments_.join(' ')} was terminated by ${signal}.`
            : `${command} ${arguments_.join(' ')} exited ${String(code)}.`,
        ),
      );
    });
  });
}

async function poisonMacosRuntimeOwnership() {
  if (process.platform !== 'darwin') {
    return null;
  }
  const paths = getStatePaths(namespace);
  const runtimeRoot = path.dirname(paths.runtimeDirectory);
  const expectedRoot = `/tmp/vite-plugin-local-tls-${String(process.getuid())}`;
  if (runtimeRoot !== expectedRoot) {
    throw new Error(`Refusing to change unexpected macOS runtime root: ${runtimeRoot}`);
  }
  await runRequiredCommand('sudo', ['--', 'chown', '-R', '0', runtimeRoot]);
  await runRequiredCommand('sudo', ['--', 'chmod', '0700', runtimeRoot]);
  const details = await stat(runtimeRoot);
  if (details.uid !== 0 || (details.mode & 0o777) !== 0o700) {
    throw new Error(`Failed to reproduce root-owned macOS runtime state: ${runtimeRoot}`);
  }
  return runtimeRoot;
}

async function assertMacosRuntimeOwnershipRecovered(runtimeRoot) {
  if (!runtimeRoot) {
    return;
  }
  const [rootDetails, namespaceDetails] = await Promise.all([
    stat(runtimeRoot),
    stat(getStatePaths(namespace).runtimeDirectory),
  ]);
  const uid = process.getuid();
  if (rootDetails.uid !== uid || namespaceDetails.uid !== uid) {
    throw new Error(`macOS runtime ownership was not recovered for uid ${String(uid)}.`);
  }
}

async function assertPathAbsent(filePath) {
  try {
    await access(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  throw new Error(`Startup-service cleanup left ${filePath}.`);
}

async function assertStartupServiceRemoved(record) {
  const paths = getStatePaths(namespace);
  await Promise.all([
    assertPathAbsent(path.join(paths.stateDirectory, 'service-install.json')),
    assertPathAbsent(path.join(paths.stateDirectory, 'service-install-v2.json')),
    assertPathAbsent(path.join(paths.stateDirectory, 'service-install-previous.json')),
    assertPathAbsent(record.runtimeDirectory),
    ...(record.definitionPath ? [assertPathAbsent(record.definitionPath)] : []),
  ]);
  const command =
    process.platform === 'darwin'
      ? ['launchctl', ['print', `system/${record.identifier}`]]
      : process.platform === 'linux'
        ? ['systemctl', ['cat', `${record.identifier}.service`]]
        : ['schtasks.exe', ['/Query', '/TN', record.identifier]];
  let absentChecks = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    absentChecks = (await commandSucceeds(command[0], command[1])) ? 0 : absentChecks + 1;
    if (absentChecks === 2) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Startup manager still reports ${record.identifier} after uninstall.`);
}

async function waitForRunningService() {
  let lastStatus = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    lastStatus = parseStatus(await runCli(['proxy', 'status']));
    if (lastStatus.running && lastStatus.compatible && lastStatus.state?.port === 443) {
      return lastStatus;
    }
    await delay(500);
  }
  const diagnostics = await serviceDiagnostics();
  throw new Error(
    `Installed service did not become ready: ${JSON.stringify(lastStatus)}\n${diagnostics.join('\n')}`,
  );
}

function connectToTlsListener() {
  return new Promise((resolve, reject) => {
    const socket = connect(
      {
        host: '127.0.0.1',
        port: 443,
        servername: 'unconfigured.vite-local-tls.invalid',
        rejectUnauthorized: false,
      },
      () => {
        const certificate = socket.getPeerCertificate();
        if (!certificate.raw) {
          socket.destroy();
          reject(new Error('The service listener did not present a TLS certificate.'));
          return;
        }
        resolve(socket);
      },
    );
    socket.once('error', reject);
  });
}

let installAttempted = false;
let activeConnection = null;
let uninstallSucceeded = false;
let installedRecord = null;
try {
  installAttempted = true;
  await runCli(['service', 'install'], true);
  installedRecord = JSON.parse(
    await readFile(
      path.join(getStatePaths(namespace).stateDirectory, 'service-install-v2.json'),
      'utf8',
    ),
  );
  const firstStatus = await waitForRunningService();
  assertHealthyDoctor(await runCli(['doctor']));
  activeConnection = await connectToTlsListener();
  activeConnection.on('error', () => undefined);
  if (firstStatus.state.namespace !== 'default') {
    throw new Error(`Service namespace mismatch: ${JSON.stringify(firstStatus)}`);
  }
  const poisonedRuntimeRoot = await poisonMacosRuntimeOwnership();
  await runCli(['service', 'install'], true);
  const replacementStatus = await waitForRunningService();
  await assertMacosRuntimeOwnershipRecovered(poisonedRuntimeRoot);
  const replacementConnection = await connectToTlsListener();
  replacementConnection.destroy();
  if (replacementStatus.state.pid === firstStatus.state.pid) {
    throw new Error(
      `${process.platform} service replacement reused the old process: ${JSON.stringify(replacementStatus)}`,
    );
  }
  console.log(
    `Verified port-443 startup service installation and live-connection replacement on ${process.platform}.`,
  );
} finally {
  activeConnection?.destroy();
  if (installAttempted) {
    await runCli(['service', 'uninstall'], true)
      .then(async () => {
        if (installedRecord) {
          await assertStartupServiceRemoved(installedRecord);
        }
        uninstallSucceeded = true;
      })
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
  }
  if (!installAttempted || uninstallSucceeded) {
    const paths = getStatePaths(namespace);
    await Promise.all([
      rm(paths.stateDirectory, { recursive: true, force: true }),
      process.platform === 'win32'
        ? Promise.resolve()
        : rm(paths.runtimeDirectory, { recursive: true, force: true }),
    ]);
  }
}
