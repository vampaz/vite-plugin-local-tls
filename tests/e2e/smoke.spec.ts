import { readFile } from 'node:fs/promises';
import { connect } from 'node:tls';
import { expect, test } from './fixtures.js';
import { startServer } from '../fixtures/server-process.js';

function trustedConnection(
  hostname: string,
  port: number,
  certificateAuthority: Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(
      {
        host: '127.0.0.1',
        port,
        ca: certificateAuthority,
        servername: hostname,
      },
      () => {
        socket.end();
        resolve();
      },
    );
    socket.once('error', reject);
  });
}

test('serves the installed playground through validated local TLS', async ({ page, e2e }) => {
  const domain = 'smoke.localhost';
  const server = await startServer(e2e, {
    domains: [domain],
    marker: 'installed-smoke',
    checkout: 'regular-clone',
    branch: 'smoke',
  });
  const url = new URL(`https://${domain}:${e2e.proxyPort}/`);
  await page.goto(url.href);

  await expect(page.locator('#marker')).toHaveText('installed-smoke');
  await expect(page.locator('#checkout')).toHaveText('regular-clone');
  await expect(page.locator('#branch')).toHaveText('smoke');
  await expect(page.locator('#protocol')).toHaveText('https:');
  await expect(page.locator('#hmr')).toHaveText('available');

  const authority = await readFile(e2e.paths.caCertificatePath);
  await expect(trustedConnection(domain, e2e.proxyPort, authority)).resolves.toBeUndefined();
  expect(server.output()).toContain(`Local TLS URL: https://${domain}`);
  expect(server.output()).toContain(`Local TLS upstream: http://127.0.0.1:${server.vitePort}`);
});
