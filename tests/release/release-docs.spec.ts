import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

async function readDocuments(): Promise<Record<string, string>> {
  const names = ['README.md', 'CONTRIBUTING.md', 'RELEASING.md'];
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await readFile(`${repositoryRoot}/${name}`, 'utf8')]),
    ),
  );
}

describe('release documentation', () => {
  it('documents Changeset selection and the two tested pull-request stages', async () => {
    const documents = await readDocuments();
    const releasing = documents['RELEASING.md'];

    expect(releasing).toContain('patch');
    expect(releasing).toContain('minor');
    expect(releasing).toContain('major');
    expect(releasing).toContain('Version Packages');
    expect(releasing).toContain('complete `Tests` workflow a second time');
    expect(releasing).toContain('npm run changeset -- status');
  });

  it('documents OIDC, settings, bootstrap, and post-publication verification', async () => {
    const documents = await readDocuments();
    const releasing = documents['RELEASING.md'];

    for (const requirement of [
      'Allow GitHub Actions to create and approve pull requests',
      'vampaz',
      'vite-plugin-local-tls',
      'release.yml',
      'npm publish',
      'trusted publisher',
      'short-lived granular credential',
      'revoke the bootstrap credential',
      'disable token publishing',
      'npm run verify:published',
      'provenance',
    ]) {
      expect(releasing).toContain(requirement);
    }
  });

  it('prohibits manual releases and defines immutable rollback records', async () => {
    const documents = await readDocuments();
    const combined = Object.values(documents).join('\n');

    expect(combined).toContain('Do not run a local publish');
    expect(combined).toContain('Do not force-move a tag');
    expect(combined).toContain('Do not edit `package.json` version');
    expect(combined).toContain('corrective Changeset');
    expect(documents['README.md']).toContain('[RELEASING.md](./RELEASING.md)');
  });
});
