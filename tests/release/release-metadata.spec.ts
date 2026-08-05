import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(`${repositoryRoot}/${relativePath}`, 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('release metadata', () => {
  it('configures Changesets for the public master-based package flow', async () => {
    const config = await readJson('.changeset/config.json');

    expect(config).toEqual({
      $schema: 'https://unpkg.com/@changesets/config/schema.json',
      changelog: '@changesets/cli/changelog',
      commit: false,
      fixed: [],
      linked: [],
      access: 'public',
      baseBranch: 'master',
      updateInternalDependencies: 'patch',
      ignore: [],
    });
  });

  it('keeps the scoped package identity and release scripts publishable', async () => {
    const manifest = await readJson('package.json');
    const scripts = manifest.scripts as Record<string, string>;
    const dependencies = manifest.devDependencies as Record<string, string>;

    expect(manifest.name).toBe('@vampaz/vite-plugin-local-tls');
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/vampaz/vite-plugin-local-tls.git',
    });
    expect(manifest.publishConfig).toEqual({ access: 'public' });
    expect(manifest.bin).toEqual({ 'vite-local-tls': 'dist/cli.js' });
    expect(manifest.files).toEqual([
      'CHANGELOG.md',
      'CONTRIBUTING.md',
      'dist',
      'MIGRATION.md',
      'RELEASING.md',
      'SECURITY.md',
    ]);
    expect(scripts).toMatchObject({
      changeset: 'changeset',
      'changeset:version': 'changeset version',
      'changeset:publish': 'changeset publish',
      prepublishOnly: 'npm run build',
      prepare: 'husky',
    });
    expect(dependencies['@changesets/cli']).toBe('^2.31.1');
    expect(dependencies.husky).toBe('^9.1.7');
  });

  it('formats, lints, and restages only previously staged files on commit', async () => {
    const hook = await readFile(`${repositoryRoot}/.husky/pre-commit`, 'utf8');

    expect(hook).toContain('git diff --cached --name-only --diff-filter=ACMR');
    expect(hook).toContain('npm run format');
    expect(hook).toContain('npm run lint');
    expect(hook).toContain('git add -- "$file_path"');
    expect(hook).not.toContain('--no-verify');
  });

  it('ships an initialized changelog and contributor guide', async () => {
    const [changelog, contributing] = await Promise.all(
      ['CHANGELOG.md', 'CONTRIBUTING.md'].map((name) =>
        readFile(`${repositoryRoot}/${name}`, 'utf8'),
      ),
    );

    expect(changelog).toContain('@vampaz/vite-plugin-local-tls');
    expect(changelog).toContain('0.0.1');
    expect(contributing).toContain('npm run changeset');
    expect(contributing).not.toContain('Install Caddy');
  });

  it('records the one-time bootstrap without requesting a version change', async () => {
    const changeset = await readFile(`${repositoryRoot}/.changeset/caddyless-bootstrap.md`, 'utf8');

    expect(changeset).toMatch(/^---\n---\n/);
    expect(changeset).toContain('release-acceptance gate');
    expect(changeset).not.toContain(`'@vampaz/vite-plugin-local-tls':`);
  });
});
