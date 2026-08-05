import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('release artifact verification', () => {
  it('uses only safe package and dry-run commands before publication', async () => {
    const source = await readFile(`${repositoryRoot}/scripts/verify-release-dry-run.mjs`, 'utf8');

    expect(source).toContain("['run', 'verify:zero-deps']");
    expect(source).toContain("['run', 'verify:package']");
    expect(source).toContain("['pack', '--dry-run', '--json']");
    expect(source).toContain('No publication attempted.');
    expect(source).not.toMatch(/\['publish'/);
    expect(source).not.toContain('changeset:publish');
  });

  it('checks registry, provenance, tag, release, and consumer installation after publication', async () => {
    const source = await readFile(`${repositoryRoot}/scripts/verify-published-release.mjs`, 'utf8');

    for (const evidence of [
      "['view', specifier, '--json']",
      "['view', packageName, 'dist-tags', '--json']",
      'https://slsa.dev/provenance/v1',
      '.github/workflows/release.yml',
      'ls-remote',
      "'release'",
      "'view'",
      'Consumer installed the wrong version.',
      'Published CLI did not run.',
    ]) {
      expect(source).toContain(evidence);
    }
    expect(source).not.toMatch(/\['publish'/);
    expect(source).not.toContain('NPM_TOKEN');
  });

  it('exposes both verifiers through package scripts', async () => {
    const manifest = JSON.parse(await readFile(`${repositoryRoot}/package.json`, 'utf8')) as Record<
      string,
      any
    >;

    expect(manifest.scripts['verify:release-dry-run']).toBe(
      'node scripts/verify-release-dry-run.mjs',
    );
    expect(manifest.scripts['verify:published']).toBe('node scripts/verify-published-release.mjs');
  });
});
