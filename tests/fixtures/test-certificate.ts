import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type TestCertificate = { key: Buffer; cert: Buffer };

export async function createTestCertificate(
  directory: string,
  hostname = 'app.localhost',
): Promise<TestCertificate> {
  const keyPath = path.join(directory, 'key.pem');
  const certificatePath = path.join(directory, 'certificate.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certificatePath,
      '-subj',
      `/CN=${hostname}`,
      '-addext',
      `subjectAltName=DNS:${hostname}`,
      '-addext',
      'basicConstraints=critical,CA:FALSE',
      '-addext',
      'extendedKeyUsage=serverAuth',
      '-days',
      '1',
    ],
    { stdio: 'ignore' },
  );
  return { key: await readFile(keyPath), cert: await readFile(certificatePath) };
}
