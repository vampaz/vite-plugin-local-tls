import { compactDomainLabel } from '../../src/domain-resolution.js';
import { startServer } from '../fixtures/server-process.js';
import { expect, test } from './fixtures.js';

test('normalizes explicit domains and serves every unique hostname', async ({ page, e2e }) => {
  const server = await startServer(e2e, {
    domains: [' First.LOCALHOST ', 'second.localhost', 'first.localhost'],
    marker: 'explicit-domains',
  });

  for (const domain of ['first.localhost', 'second.localhost']) {
    await page.goto(`https://${domain}:${e2e.proxyPort}/`);
    await expect(page.locator('#marker')).toHaveText('explicit-domains');
  }
  expect(server.output().match(/Local TLS URL:/g)).toHaveLength(2);
});

for (const loopbackDomain of ['localtest.me', 'lvh.me', 'nip.io'] as const) {
  test(`serves the ${loopbackDomain} derived domain`, async ({ page, e2e }) => {
    const baseDomain = loopbackDomain === 'nip.io' ? '127.0.0.1.nip.io' : loopbackDomain;
    const domain = `domain-matrix.feature.${baseDomain}`;
    await startServer(e2e, {
      expectedDomains: [domain],
      marker: loopbackDomain,
      environment: {
        VITE_TLS_REPO: 'domain-matrix',
        VITE_TLS_BRANCH: 'feature',
        VITE_TLS_LOOPBACK_DOMAIN: loopbackDomain,
      },
    });

    await page.goto(`https://${domain}:${e2e.proxyPort}/`);
    await expect(page.locator('#marker')).toHaveText(loopbackDomain);
  });
}

test('compacts long derived labels and accepts a custom base domain', async ({ e2e }) => {
  const repository = `repository-${'r'.repeat(90)}`;
  const branch = `feature-${'b'.repeat(90)}`;
  const domain = `${compactDomainLabel(repository)}.${compactDomainLabel(branch)}.example.test`;
  const server = await startServer(e2e, {
    expectedDomains: [domain],
    marker: 'custom-base',
    environment: {
      VITE_TLS_REPO: repository,
      VITE_TLS_BRANCH: branch,
      VITE_TLS_BASE_DOMAIN: '.Example.Test.',
    },
  });

  expect(server.output()).toContain(`Local TLS URL: https://${domain}`);
  expect(domain.split('.').every((label) => label.length <= 63)).toBe(true);
});

test('prints an actionable diagnostic for an invalid explicit domain', async ({ e2e }) => {
  const server = await startServer(e2e, {
    domains: ['   '],
    marker: 'invalid-domain',
    expectedOutput: /`domain` is empty after trimming/,
  });

  expect(server.output()).toContain('Provide `domain`');
  expect(server.output()).not.toContain('Local TLS URL:');
});
