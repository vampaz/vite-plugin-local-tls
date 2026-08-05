import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { connect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { getStatePaths } from '../dist/testing.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = path.join(repositoryRoot, 'dist', 'cli.js');
const namespace = `platform-smoke-${process.pid}`;

function runCli(arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...arguments_, '--namespace', namespace], {
      cwd: repositoryRoot,
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
        resolve(stdout);
      } else {
        reject(new Error(`vite-local-tls ${arguments_.join(' ')} failed:\n${stderr}${stdout}`));
      }
    });
  });
}

function parseStatus(output) {
  const status = JSON.parse(output);
  if (!status || typeof status !== 'object') {
    throw new Error(`Invalid service status: ${output}`);
  }
  return status;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  throw new Error(`Installed service did not become ready: ${JSON.stringify(lastStatus)}`);
}

function verifyTlsListener() {
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
        socket.end();
        if (!certificate.raw) {
          reject(new Error('The service listener did not present a TLS certificate.'));
          return;
        }
        resolve();
      },
    );
    socket.once('error', reject);
  });
}

let installed = false;
try {
  await runCli(['service', 'install']);
  installed = true;
  const status = await waitForRunningService();
  await verifyTlsListener();
  if (status.state.namespace !== namespace) {
    throw new Error(`Service namespace mismatch: ${JSON.stringify(status)}`);
  }
  console.log(`Verified port-443 startup service on ${process.platform}.`);
} finally {
  if (installed) {
    await runCli(['service', 'uninstall']).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
  const paths = getStatePaths(namespace);
  await Promise.all([
    rm(paths.stateDirectory, { recursive: true, force: true }),
    process.platform === 'win32'
      ? Promise.resolve()
      : rm(paths.runtimeDirectory, { recursive: true, force: true }),
  ]);
}
