import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCheckout } from './checkout-resolution.js';

let temporaryDirectory: string;
let repositoryDirectory: string;

function git(cwd: string, ...arguments_: string[]): string {
  return execFileSync('git', arguments_, { cwd, encoding: 'utf8' }).trim();
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-checkout-'));
  repositoryDirectory = path.join(temporaryDirectory, 'sample-repository');
  await mkdir(repositoryDirectory);
  git(repositoryDirectory, 'init', '-b', 'master');
  git(repositoryDirectory, 'config', 'user.email', 'tests@example.test');
  git(repositoryDirectory, 'config', 'user.name', 'Tests');
  await writeFile(path.join(repositoryDirectory, 'README.md'), 'fixture');
  git(repositoryDirectory, 'add', 'README.md');
  git(repositoryDirectory, 'commit', '-m', 'fixture');
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('resolveCheckout', () => {
  it('resolves a regular clone from a nested working directory', async () => {
    const nestedDirectory = path.join(repositoryDirectory, 'one', 'two');
    await mkdir(nestedDirectory, { recursive: true });

    expect(resolveCheckout({}, nestedDirectory)).toEqual({
      repo: 'sample-repository',
      branch: 'master',
    });
  });

  it('uses the common repository identity for a linked worktree', () => {
    const worktreeDirectory = path.join(temporaryDirectory, 'differently-named-worktree');
    git(repositoryDirectory, 'worktree', 'add', '-b', 'feature/editor', worktreeDirectory);

    expect(resolveCheckout({}, worktreeDirectory)).toEqual({
      repo: 'sample-repository',
      branch: 'feature/editor',
    });
  });

  it('represents detached HEAD with the short commit SHA', () => {
    const shortCommit = git(repositoryDirectory, 'rev-parse', '--short', 'HEAD');
    git(repositoryDirectory, 'checkout', '--detach');

    expect(resolveCheckout({}, repositoryDirectory)).toEqual({
      repo: 'sample-repository',
      branch: shortCommit,
    });
  });

  it('keeps explicit overrides when Git is unavailable', () => {
    function unavailableGit(): never {
      throw new Error('git unavailable');
    }

    expect(
      resolveCheckout(
        { repo: 'explicit-repo', branch: 'feature/manual' },
        '/missing',
        unavailableGit,
      ),
    ).toEqual({
      repo: 'explicit-repo',
      branch: 'feature/manual',
    });
    expect(resolveCheckout({}, '/missing', unavailableGit)).toEqual({
      repo: undefined,
      branch: undefined,
    });
  });
});
