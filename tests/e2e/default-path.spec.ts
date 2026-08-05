import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { startServer } from '../fixtures/server-process.js';

function run(
  command: string,
  arguments_: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', (chunk) => output.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('exit', (code) => {
      const stdout = Buffer.concat(output).toString();
      const stderr = Buffer.concat(errors).toString();
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} ${arguments_.join(' ')} failed:\n${stderr}${stdout}`));
      }
    });
  });
}

test('runs the packed default plugin on trusted port 443 with WSS HMR', async ({ e2e }) => {
  test.skip(
    process.env.VITE_TLS_DEFAULT_PATH !== 'true',
    'The privileged default-path proof runs in its isolated workflow step.',
  );
  const domain = 'default-path.localhost';
  const environment = { ...process.env, HOME: e2e.stateHome };
  const cliPath = path.join(
    e2e.fixtureDirectory,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'vite-local-tls.cmd' : 'vite-local-tls',
  );
  const nssDirectory = path.join(e2e.stateHome, '.pki', 'nssdb');
  const browserProfile = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-browser-'));
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  let serviceInstalled = false;
  try {
    await run(cliPath, ['trust', '--namespace', e2e.namespace], e2e.fixtureDirectory, environment);
    await run(
      cliPath,
      ['service', 'install', '--namespace', e2e.namespace],
      e2e.fixtureDirectory,
      environment,
    );
    serviceInstalled = true;
    await mkdir(nssDirectory, { recursive: true });
    await run(
      'certutil',
      ['-N', '--empty-password', '-d', `sql:${nssDirectory}`],
      e2e.root,
      environment,
    );
    await run(
      'certutil',
      [
        '-A',
        '-d',
        `sql:${nssDirectory}`,
        '-n',
        `vite-local-tls-${e2e.namespace}`,
        '-t',
        'C,,',
        '-i',
        e2e.paths.caCertificatePath,
      ],
      e2e.root,
      environment,
    );
    server = await startServer(e2e, {
      domains: [domain],
      marker: 'default-public-plugin',
      environment: { VITE_TLS_DEFAULT_PATH: 'true' },
    });
    const context = await chromium.launchPersistentContext(browserProfile, {
      headless: true,
      ignoreHTTPSErrors: false,
      env: environment,
    });
    try {
      const page = await context.newPage();
      await page.goto(`https://${domain}/`);
      await expect(page.locator('#marker')).toHaveText('default-public-plugin');
      await expect(page.locator('#protocol')).toHaveText('https:');
      await expect(page.locator('#hmr')).toHaveText('available');
      await expect(page.locator('#message')).toHaveText('initial message');

      await writeFile(
        path.join(e2e.fixtureDirectory, 'src', 'message.ts'),
        "export const message = 'default path HMR update';\n",
      );
      await expect(page.locator('#message')).toHaveText('default path HMR update');
    } finally {
      await context.close();
    }
  } finally {
    await server?.stop().catch(() => undefined);
    if (serviceInstalled) {
      await run(
        cliPath,
        ['service', 'uninstall', '--namespace', e2e.namespace],
        e2e.fixtureDirectory,
        environment,
      ).catch(() => undefined);
    }
    await run(
      cliPath,
      ['untrust', '--namespace', e2e.namespace],
      e2e.fixtureDirectory,
      environment,
    ).catch(() => undefined);
    await rm(browserProfile, { recursive: true, force: true });
  }
});
