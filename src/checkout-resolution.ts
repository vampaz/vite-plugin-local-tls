import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { CheckoutInfo } from './interfaces/checkout-info.js';

export type GitRunner = (arguments_: string[], cwd: string) => string;

function executeGit(arguments_: string[], cwd: string): string {
  return execFileSync('git', arguments_, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function detectRepositoryName(cwd: string, runGit: GitRunner): string | undefined {
  try {
    const commonDirectory = runGit(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      cwd,
    );
    if (commonDirectory) {
      return path.basename(
        path.basename(commonDirectory) === '.git' ? path.dirname(commonDirectory) : commonDirectory,
      );
    }
  } catch {}

  try {
    const repositoryRoot = runGit(['rev-parse', '--show-toplevel'], cwd);
    return repositoryRoot ? path.basename(repositoryRoot) : undefined;
  } catch {
    return undefined;
  }
}

function detectBranch(cwd: string, runGit: GitRunner): string | undefined {
  try {
    const branch = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
    if (branch) {
      return branch;
    }
  } catch {}

  try {
    const commit = runGit(['rev-parse', '--short', 'HEAD'], cwd);
    return commit || undefined;
  } catch {
    return undefined;
  }
}

export function resolveCheckout(
  overrides: CheckoutInfo = {},
  cwd = process.cwd(),
  runGit: GitRunner = executeGit,
): CheckoutInfo {
  return {
    repo: overrides.repo || detectRepositoryName(cwd, runGit),
    branch: overrides.branch || detectBranch(cwd, runGit),
  };
}

export function getGitRepoInfo(cwd = process.cwd()): CheckoutInfo {
  return resolveCheckout({}, cwd);
}
