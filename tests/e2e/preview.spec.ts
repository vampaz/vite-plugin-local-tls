import { startServer } from '../fixtures/server-process.js';
import { expect, test } from './fixtures.js';

test('serves a built Vite preview through the shared HTTPS listener', async ({ page, e2e }) => {
  const domain = 'preview.localhost';
  const server = await startServer(e2e, {
    domains: [domain],
    marker: 'preview-build',
    mode: 'preview',
  });

  await page.goto(`https://${domain}:${e2e.proxyPort}/`);
  await expect(page.locator('#marker')).toHaveText('preview-build');
  await expect(page.locator('#protocol')).toHaveText('https:');
  await expect(page.locator('#hmr')).toHaveText('unavailable');
  expect(server.output()).toContain(`Local TLS upstream: http://127.0.0.1:${server.vitePort}`);
});
