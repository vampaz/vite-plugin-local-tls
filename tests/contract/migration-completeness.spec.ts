import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { legacyOptionContract } from '../fixtures/current-contract.js';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

async function readMigrationGuide(): Promise<string> {
  return readFile(`${repositoryRoot}/MIGRATION.md`, 'utf8');
}

describe('Caddy migration contract', () => {
  it('maps every legacy option explicitly', async () => {
    const migration = await readMigrationGuide();

    for (const option of legacyOptionContract) {
      expect(migration).toContain(`\`${option.name}\``);
      if ('replacement' in option && option.replacement) {
        expect(migration).toContain(`\`${option.replacement}\``);
      }
    }
  });

  it('maps imports, helpers, output, and operational behavior', async () => {
    const migration = await readMigrationGuide();

    for (const mapping of [
      'vite-plugin-caddy-multiple-tls',
      '@vampaz/vite-plugin-local-tls',
      'resolveCaddyTlsDomains',
      'resolveLocalTlsDomains',
      'resolveCaddyTlsUrl',
      'resolveLocalTlsUrl',
      'Local TLS URL',
      'latest-started-wins',
      'control channel',
      'vite-local-tls trust',
      'vite-local-tls service install',
    ]) {
      expect(migration).toContain(mapping);
    }
  });
});
