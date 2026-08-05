import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

function verifyPackage(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'verify:package'], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', (chunk) => output.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('exit', (code) => {
      const stdout = Buffer.concat(output).toString();
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${Buffer.concat(errors).toString()}${stdout}`));
    });
  });
}

describe('installed package', () => {
  it('loads public exports, declarations, and the CLI from the packed artifact', async () => {
    await expect(verifyPackage()).resolves.toContain(
      'Verified packed files, installed exports, declarations, and CLI entry point.',
    );
  }, 60_000);
});
