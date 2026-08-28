import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

async function readSecurityDocuments(): Promise<string> {
  const documents = await Promise.all(
    ['README.md', 'SECURITY.md'].map((name) => readFile(`${repositoryRoot}/${name}`, 'utf8')),
  );
  return documents.join('\n');
}

describe('security documentation contract', () => {
  it('states every local CA and listener boundary', async () => {
    const documentation = await readSecurityDocuments();

    for (const boundary of [
      'CA private key',
      'exact hostname',
      '127.0.0.1',
      '::1',
      'port 443',
      'control socket',
      'named pipe',
      'unrelated listener',
      'vite-local-tls untrust',
      'canonical startup service',
      'SuccessfulExit',
    ]) {
      expect(documentation).toContain(boundary);
    }
  });

  it('does not over-promise DNS or embedded-browser trust', async () => {
    const documentation = await readSecurityDocuments();

    expect(documentation).toContain('public DNS');
    expect(documentation).toContain('offline');
    expect(documentation).toContain('embedded browser');
    expect(documentation).toContain('separate trust store');
    expect(documentation).toContain('Removing Caddy does not');
  });
});
