import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageContract {
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
}

const expectedVersions = {
  vite3: 'npm:vite@3.2.11',
  vite4: 'npm:vite@4.5.14',
  vite5: 'npm:vite@5.4.21',
  vite6: 'npm:vite@6.4.3',
  vite7: 'npm:vite@7.3.6',
  vite: '^8.2.0',
};

describe('supported Vite versions', () => {
  it('pins each contract fixture to the latest release in its major', async () => {
    const packageContract = JSON.parse(
      await readFile(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as PackageContract;

    expect(packageContract.devDependencies).toMatchObject(expectedVersions);
    expect(packageContract.peerDependencies.vite).toBe(
      '^3.0.0 || ^4.0.0 || ^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0',
    );
  });
});
