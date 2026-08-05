import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { startServer } from '../fixtures/server-process.js';
import { expect, test } from './fixtures.js';

async function expectMarker(page: Page, url: string, marker: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator('#marker')).toHaveText(marker);
}

test('serializes four simultaneous starts without losing distinct routes', async ({
  page,
  e2e,
}) => {
  const fixtures = Array.from({ length: 4 }, (_, index) => ({
    domain: `concurrent-${index}.localhost`,
    marker: `concurrent-${index}`,
  }));
  await Promise.all(
    fixtures.map(({ domain, marker }) => startServer(e2e, { domains: [domain], marker })),
  );

  for (const { domain, marker } of fixtures) {
    await expectMarker(page, `https://${domain}:${e2e.proxyPort}/`, marker);
  }
  const state = JSON.parse(await readFile(e2e.paths.stateFile, 'utf8')) as { pid: number };
  expect([...e2e.servers].filter(({ child }) => child.pid === state.pid)).toHaveLength(1);
});

test('preserves a sibling during partial multi-domain takeover and old-owner shutdown', async ({
  page,
  e2e,
}) => {
  const oldServer = await startServer(e2e, {
    domains: ['partial-app.localhost', 'partial-api.localhost'],
    marker: 'partial-old',
  });
  const newServer = await startServer(e2e, {
    domains: ['partial-app.localhost'],
    marker: 'partial-new',
  });

  await expectMarker(page, `https://partial-app.localhost:${e2e.proxyPort}/`, 'partial-new');
  await expectMarker(page, `https://partial-api.localhost:${e2e.proxyPort}/`, 'partial-old');
  await oldServer.stop('SIGTERM');
  await expectMarker(page, `https://partial-app.localhost:${e2e.proxyPort}/`, 'partial-new');
  expect(newServer.child.exitCode).toBeNull();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`releases an exact route on ${signal} and allows immediate restart`, async ({
    page,
    e2e,
  }) => {
    const domain = `${signal.toLowerCase()}.localhost`;
    const first = await startServer(e2e, { domains: [domain], marker: `${signal}-first` });
    await expectMarker(page, `https://${domain}:${e2e.proxyPort}/`, `${signal}-first`);
    await first.stop(signal);

    const second = await startServer(e2e, { domains: [domain], marker: `${signal}-second` });
    await expectMarker(page, `https://${domain}:${e2e.proxyPort}/`, `${signal}-second`);
    expect(second.child.exitCode).toBeNull();
  });
}

test('recovers a force-killed route and stale daemon metadata without touching survivors', async ({
  page,
  e2e,
}) => {
  const crashDomain = 'sigkill.localhost';
  const crashed = await startServer(e2e, { domains: [crashDomain], marker: 'before-sigkill' });
  const survivor = await startServer(e2e, {
    domains: ['daemon-survivor.localhost'],
    marker: 'daemon-survivor',
  });
  await crashed.stop('SIGKILL');
  const restarted = await startServer(e2e, { domains: [crashDomain], marker: 'after-sigkill' });
  await expectMarker(page, `https://${crashDomain}:${e2e.proxyPort}/`, 'after-sigkill');

  const oldState = JSON.parse(await readFile(e2e.paths.stateFile, 'utf8')) as { pid: number };
  const daemonHost = [...e2e.servers].find(({ child }) => child.pid === oldState.pid);
  expect(daemonHost).toBeDefined();
  const survivingServer = daemonHost === survivor ? restarted : survivor;
  await daemonHost!.stop('SIGKILL');
  await expect
    .poll(async () => {
      try {
        const state = JSON.parse(await readFile(e2e.paths.stateFile, 'utf8')) as { pid: number };
        return state.pid;
      } catch {
        return oldState.pid;
      }
    })
    .not.toBe(oldState.pid);

  await expectMarker(
    page,
    `https://${survivingServer.domains[0]}:${e2e.proxyPort}/`,
    survivingServer.marker,
  );
  expect(survivingServer.child.exitCode).toBeNull();
});
