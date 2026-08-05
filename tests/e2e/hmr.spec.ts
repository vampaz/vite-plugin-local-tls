import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCheckouts } from '../fixtures/create-checkouts.js';
import { startServer } from '../fixtures/server-process.js';
import { expect, test } from './fixtures.js';

test('delivers WSS HMR only to the edited checkout', async ({ browser, e2e }) => {
  const checkouts = await createCheckouts(e2e);
  const primaryDomain = 'project.master.localhost';
  const cloneDomain = 'project.feature-editor.localhost';
  await Promise.all([
    startServer(e2e, {
      cwd: checkouts.primary,
      expectedDomains: [primaryDomain],
      marker: 'hmr-primary',
    }),
    startServer(e2e, {
      cwd: checkouts.clone,
      expectedDomains: [cloneDomain],
      marker: 'hmr-clone',
    }),
  ]);
  const primaryContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const cloneContext = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const primaryPage = await primaryContext.newPage();
    const clonePage = await cloneContext.newPage();
    await Promise.all([
      primaryPage.goto(`https://${primaryDomain}:${e2e.proxyPort}/`),
      clonePage.goto(`https://${cloneDomain}:${e2e.proxyPort}/`),
    ]);
    await expect(primaryPage.locator('#message')).toHaveText('initial message');
    await expect(clonePage.locator('#message')).toHaveText('initial message');

    await writeFile(
      path.join(checkouts.primary, 'src', 'message.ts'),
      "export const message = 'updated primary message';\n",
    );

    await expect(primaryPage.locator('#message')).toHaveText('updated primary message');
    await expect(clonePage.locator('#message')).toHaveText('initial message');
  } finally {
    await Promise.all([primaryContext.close(), cloneContext.close()]);
  }
});
