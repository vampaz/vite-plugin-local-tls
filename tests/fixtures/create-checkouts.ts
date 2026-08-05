import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { E2eContext } from './server-process.js';

export interface CheckoutFixtures {
  primary: string;
  clone: string;
  secondClone: string;
  worktree: string;
}

function runGit(cwd: string, arguments_: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', arguments_, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const errors: Buffer[] = [];
    child.stderr.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`git ${arguments_.join(' ')} failed: ${Buffer.concat(errors).toString()}`),
        );
      }
    });
  });
}

async function linkDependencies(context: E2eContext, checkout: string): Promise<void> {
  await symlink(
    path.join(context.fixtureDirectory, 'node_modules'),
    path.join(checkout, 'node_modules'),
  );
}

export async function createCheckouts(context: E2eContext): Promise<CheckoutFixtures> {
  const root = await mkdtemp(path.join(context.root, 'checkouts-'));
  const primary = path.join(root, 'seed', 'project');
  const clone = path.join(root, 'clone', 'project');
  const secondClone = path.join(root, 'clone-api', 'project');
  const worktree = path.join(root, 'worktrees', 'review');
  await mkdir(path.dirname(primary), { recursive: true });
  await cp(context.fixtureDirectory, primary, {
    recursive: true,
    filter(source): boolean {
      return path.basename(source) !== 'node_modules';
    },
  });
  await writeFile(path.join(primary, '.gitignore'), 'node_modules/\ndist/\n');
  await runGit(primary, ['init', '-b', 'master']);
  await runGit(primary, ['config', 'user.name', 'Vite TLS Test']);
  await runGit(primary, ['config', 'user.email', 'vite-tls@example.test']);
  await runGit(primary, ['add', '.']);
  await runGit(primary, ['commit', '-m', 'fixture']);
  await mkdir(path.dirname(clone), { recursive: true });
  await runGit(path.dirname(clone), ['clone', primary, clone]);
  await runGit(clone, ['checkout', '-b', 'feature/editor']);
  await mkdir(path.dirname(secondClone), { recursive: true });
  await runGit(path.dirname(secondClone), ['clone', primary, secondClone]);
  await runGit(secondClone, ['checkout', '-b', 'feature/api']);
  await mkdir(path.dirname(worktree), { recursive: true });
  await runGit(primary, ['worktree', 'add', '-b', 'review', worktree]);
  await Promise.all([
    linkDependencies(context, primary),
    linkDependencies(context, clone),
    linkDependencies(context, secondClone),
    linkDependencies(context, worktree),
  ]);
  return { primary, clone, secondClone, worktree };
}
