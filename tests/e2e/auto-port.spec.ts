import { createServer } from 'node:net';
import { findAvailablePort, startServer } from '../fixtures/server-process.js';
import { expect, test } from './fixtures.js';

test('registers the auto-incremented Vite port instead of the requested port', async ({
  page,
  e2e,
}) => {
  const requestedPort = await findAvailablePort();
  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(requestedPort, '127.0.0.1', () => resolve());
  });
  try {
    const domain = 'auto-port.localhost';
    const server = await startServer(e2e, {
      domains: [domain],
      marker: 'auto-port',
      vitePort: requestedPort,
      strictPort: false,
    });

    expect(server.vitePort).not.toBe(requestedPort);
    expect(server.output()).toContain(`Local TLS upstream: http://127.0.0.1:${server.vitePort}`);
    await page.goto(`https://${domain}:${e2e.proxyPort}/`);
    await expect(page.locator('#marker')).toHaveText('auto-port');
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});
