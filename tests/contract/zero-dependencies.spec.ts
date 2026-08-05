import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

async function listRuntimeSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRuntimeSources(entryPath)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(entryPath);
    }
  }
  return files;
}

describe('zero runtime dependencies', () => {
  it('declares no dependencies and imports no external runtime package', async () => {
    const packageContract = JSON.parse(
      await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(packageContract.dependencies ?? {}).toEqual({});

    const violations: string[] = [];
    for (const sourcePath of await listRuntimeSources(path.join(repositoryRoot, 'src'))) {
      const source = await readFile(sourcePath, 'utf8');
      for (const match of source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)) {
        const specifier = match[2];
        if (
          specifier &&
          !specifier.startsWith('.') &&
          !specifier.startsWith('node:') &&
          specifier !== 'vite'
        ) {
          violations.push(`${path.relative(repositoryRoot, sourcePath)}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
