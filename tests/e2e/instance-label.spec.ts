import { startServer } from '../fixtures/server-process.js';
import { expect, test } from './fixtures.js';

test('disambiguates labeled copies and preserves exact-host latest-started takeover', async ({
  page,
  e2e,
}) => {
  const commonEnvironment = {
    VITE_TLS_REPO: 'same-app',
    VITE_TLS_BRANCH: 'main',
  };
  await Promise.all([
    startServer(e2e, {
      expectedDomains: ['same-app.main.copy-a.localhost'],
      marker: 'copy-a',
      environment: { ...commonEnvironment, VITE_TLS_INSTANCE_LABEL: 'copy-a' },
    }),
    startServer(e2e, {
      expectedDomains: ['same-app.main.copy-b.localhost'],
      marker: 'copy-b',
      environment: { ...commonEnvironment, VITE_TLS_INSTANCE_LABEL: 'copy-b' },
    }),
  ]);

  await page.goto(`https://same-app.main.copy-a.localhost:${e2e.proxyPort}/`);
  await expect(page.locator('#marker')).toHaveText('copy-a');
  await page.goto(`https://same-app.main.copy-b.localhost:${e2e.proxyPort}/`);
  await expect(page.locator('#marker')).toHaveText('copy-b');

  const first = await startServer(e2e, {
    expectedDomains: ['same-app.main.localhost'],
    marker: 'unlabeled-first',
    environment: commonEnvironment,
  });
  await page.goto(`https://same-app.main.localhost:${e2e.proxyPort}/`);
  await expect(page.locator('#marker')).toHaveText('unlabeled-first');

  const second = await startServer(e2e, {
    expectedDomains: ['same-app.main.localhost'],
    marker: 'unlabeled-second',
    environment: commonEnvironment,
  });
  await page.goto(`https://same-app.main.localhost:${e2e.proxyPort}/`);
  await expect(page.locator('#marker')).toHaveText('unlabeled-second');
  expect(first.child.exitCode).toBeNull();
  expect(second.child.exitCode).toBeNull();
});
