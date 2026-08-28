import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { startServer } from '../fixtures/server-process.js';
import { getStatePaths } from '../../src/state-paths.js';

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

test('runs the packed default plugin ephemerally on trusted port 443 with WSS HMR', async ({
  e2e,
}) => {
  test.skip(
    process.env.VITE_TLS_DEFAULT_PATH !== 'true' ||
      process.platform !== 'linux' ||
      process.env.CI !== 'true',
    'The privileged default-path proof runs only on its disposable Linux CI host.',
  );
  const domain = 'default-path.localhost';
  const environment = { ...process.env, HOME: e2e.stateHome };
  const canonicalPaths = getStatePaths('default', process.platform, environment);
  const cliPath = path.join(
    e2e.fixtureDirectory,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'vite-local-tls.cmd' : 'vite-local-tls',
  );
  const nssDirectory = path.join(e2e.stateHome, '.pki', 'nssdb');
  const browserProfile = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-browser-'));
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  let trustInstalled = false;
  try {
    const doctor = JSON.parse(
      await run(cliPath, ['doctor'], e2e.fixtureDirectory, environment),
    ) as { trust?: { trusted?: boolean } | null };
    if (doctor.trust?.trusted !== true) {
      trustInstalled = true;
      await run(cliPath, ['trust'], e2e.fixtureDirectory, environment);
    }
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
        'vite-local-tls-default',
        '-t',
        'C,,',
        '-i',
        canonicalPaths.caCertificatePath,
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
    await server.stop('SIGKILL');
    server = null;
  } finally {
    await server?.stop().catch(() => undefined);
    const persistentStateProblems: string[] = [];
    try {
      for (const filename of [
        'service-install.json',
        'service-install-v2.json',
        'service-install-previous.json',
      ]) {
        try {
          await access(path.join(canonicalPaths.stateDirectory, filename));
          persistentStateProblems.push(`${filename} still exists`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            persistentStateProblems.push(
              `${filename}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    } finally {
      if (trustInstalled) {
        await run(cliPath, ['untrust'], e2e.fixtureDirectory, environment).catch(() => undefined);
      }
      await rm(canonicalPaths.runtimeDirectory, { recursive: true, force: true });
      await rm(browserProfile, { recursive: true, force: true });
    }
    expect(persistentStateProblems).toEqual([]);
  }
});
