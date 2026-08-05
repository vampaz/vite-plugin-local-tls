import { createCheckouts } from '../fixtures/create-checkouts.js';
import { findAvailablePort, startServer } from '../fixtures/server-process.js';
import { expect, test } from './fixtures.js';

test('isolates regular clones and linked worktrees by Git-derived URL and HMR origin', async ({
  browser,
  e2e,
}) => {
  const checkouts = await createCheckouts(e2e);
  const ports = await Promise.all([
    findAvailablePort(),
    findAvailablePort(),
    findAvailablePort(),
    findAvailablePort(),
  ]);
  const fixtures = [
    {
      cwd: checkouts.primary,
      domain: 'project.master.localhost',
      marker: 'primary-master',
      branch: 'master',
      port: ports[0]!,
    },
    {
      cwd: checkouts.clone,
      domain: 'project.feature-editor.localhost',
      marker: 'independent-clone',
      branch: 'feature/editor',
      port: ports[1]!,
    },
    {
      cwd: checkouts.secondClone,
      domain: 'project.feature-api.localhost',
      marker: 'second-independent-clone',
      branch: 'feature/api',
      port: ports[2]!,
    },
    {
      cwd: checkouts.worktree,
      domain: 'project.review.localhost',
      marker: 'linked-worktree',
      branch: 'review',
      port: ports[3]!,
    },
  ];
  await Promise.all(
    fixtures.map((fixture) =>
      startServer(e2e, {
        cwd: fixture.cwd,
        expectedDomains: [fixture.domain],
        marker: fixture.marker,
        checkout: fixture.marker,
        branch: fixture.branch,
        vitePort: fixture.port,
      }),
    ),
  );

  const contexts = await Promise.all(
    fixtures.map(() => browser.newContext({ ignoreHTTPSErrors: true })),
  );
  try {
    for (let index = 0; index < fixtures.length; index += 1) {
      const fixture = fixtures[index]!;
      const context = contexts[index]!;
      const page = await context.newPage();
      const sockets: string[] = [];
      page.on('websocket', (socket) => sockets.push(socket.url()));
      await page.goto(`https://${fixture.domain}:${e2e.proxyPort}/`);
      await expect(page.locator('#marker')).toHaveText(fixture.marker);
      await expect(page.locator('#branch')).toHaveText(fixture.branch);
      await page.evaluate(
        (marker) => localStorage.setItem('checkout-marker', marker),
        fixture.marker,
      );
      expect(await page.evaluate(() => localStorage.getItem('checkout-marker'))).toBe(
        fixture.marker,
      );
      await expect.poll(() => sockets.some((url) => url.includes(fixture.domain))).toBe(true);
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
