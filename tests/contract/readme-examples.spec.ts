import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

async function readReadme(): Promise<string> {
  return readFile(`${repositoryRoot}/README.md`, 'utf8');
}

describe('README contract', () => {
  it('documents the public imports and every plugin option', async () => {
    const readme = await readReadme();

    expect(readme).toContain("from '@vampaz/vite-plugin-local-tls'");
    expect(readme).toContain('resolveLocalTlsDomains');
    expect(readme).toContain('resolveLocalTlsUrl');
    for (const option of [
      'domain',
      'baseDomain',
      'loopbackDomain',
      'repo',
      'branch',
      'instanceLabel',
      'cors',
      'controlSocket',
      'serviceNamespace',
      'serverName',
      'caddyApiUrl',
      'caddyAdminOrigin',
      'internalTls',
      'upstreamHostHeader',
    ]) {
      expect(readme).toContain(`\`${option}\``);
    }
    expect(readme).toContain('resolveCaddyTlsDomains');
    expect(readme).toContain('resolveCaddyTlsUrl');
    expect(readme).toContain('ViteCaddyTlsPluginOptions');
  });

  it('covers the supported development and operational workflows', async () => {
    const readme = await readReadme();

    for (const topic of [
      'regular clone',
      'linked worktree',
      'same branch',
      'multiple domains',
      'Vite preview',
      'Linux',
      'diagnostics',
      'Uninstall',
      'one machine-wide',
      'legacy startup services',
      'never downgrades',
      'ephemeral',
    ]) {
      expect(readme).toContain(topic);
    }
    for (const command of [
      'vite-local-tls trust',
      'vite-local-tls untrust',
      'vite-local-tls doctor',
      'vite-local-tls cert import',
      'vite-local-tls proxy status',
      'vite-local-tls service uninstall',
      'vite-local-tls clean --ca',
    ]) {
      expect(readme).toContain(command);
    }
  });
});
