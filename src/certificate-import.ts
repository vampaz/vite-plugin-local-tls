import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSecureContext, type SecureContext } from 'node:tls';
import { validateHostname } from './control-protocol.js';
import type {
  CertificateImportOptions,
  CertificateImportStoreOptions,
} from './interfaces/certificate-import-options.js';
import type { CertificateContextOptions } from './interfaces/certificate-context-options.js';
import type { CertificateRecord } from './interfaces/certificate-record.js';
import { ensureStatePaths } from './state-paths.js';

function certificateKey(hostname: string): string {
  return createHash('sha256').update(hostname).digest('hex');
}

function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.replaceAll(':', '').toLowerCase();
}

function publicKeysMatch(certificate: X509Certificate, privateKeyPem: Buffer): boolean {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicFromPrivate = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const certificatePublicKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
  return Buffer.from(publicFromPrivate).equals(Buffer.from(certificatePublicKey));
}

function completeCertificateChain(certificatePem: Buffer, chainPem: Buffer): Buffer {
  if (chainPem.subarray(0, certificatePem.length).equals(certificatePem)) {
    return chainPem;
  }
  return Buffer.concat([certificatePem, chainPem]);
}

export class CertificateImportStore {
  readonly #options: CertificateImportStoreOptions;

  constructor(options: CertificateImportStoreOptions) {
    this.#options = options;
  }

  async importCertificate(options: CertificateImportOptions): Promise<CertificateRecord> {
    const hostname = validateHostname(options.hostname);
    const [certificatePem, privateKeyPem, chainPem] = await Promise.all([
      readFile(options.certificatePath),
      readFile(options.keyPath),
      options.chainPath ? readFile(options.chainPath) : Promise.resolve(Buffer.alloc(0)),
    ]);
    const certificate = this.#validateCertificate(hostname, certificatePem, privateKeyPem);
    await ensureStatePaths(this.#options.paths);
    const key = certificateKey(hostname);
    const finalDirectory = path.join(this.#options.paths.importedCertificateDirectory, key);
    const temporaryDirectory = await mkdtemp(
      path.join(this.#options.paths.importedCertificateDirectory, '.import-'),
    );
    const certificatePath = path.join(temporaryDirectory, 'certificate.pem');
    const keyPath = path.join(temporaryDirectory, 'key.pem');
    const chainPath = path.join(temporaryDirectory, 'chain.pem');
    const recordPath = path.join(temporaryDirectory, 'record.json');
    const finalRecord: CertificateRecord = {
      hostname,
      certificatePath: path.join(finalDirectory, 'certificate.pem'),
      keyPath: path.join(finalDirectory, 'key.pem'),
      chainPath: path.join(finalDirectory, 'chain.pem'),
      fingerprint: normalizeFingerprint(certificate.fingerprint256),
      validTo: new Date(certificate.validTo).toISOString(),
      source: 'imported',
    };
    try {
      await writeFile(certificatePath, certificatePem, { mode: 0o644 });
      await writeFile(keyPath, privateKeyPem, { mode: 0o600 });
      await writeFile(chainPath, completeCertificateChain(certificatePem, chainPem), {
        mode: 0o644,
      });
      await writeFile(recordPath, `${JSON.stringify(finalRecord, null, 2)}\n`, { mode: 0o600 });
      if (process.platform !== 'win32') {
        await chmod(temporaryDirectory, 0o700);
        await chmod(keyPath, 0o600);
      }
      const backupDirectory = `${finalDirectory}.backup-${process.pid}`;
      await rm(backupDirectory, { recursive: true, force: true });
      await rename(finalDirectory, backupDirectory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
      try {
        await rename(temporaryDirectory, finalDirectory);
        await rm(backupDirectory, { recursive: true, force: true });
      } catch (error) {
        await rename(backupDirectory, finalDirectory).catch(() => undefined);
        throw error;
      }
      return finalRecord;
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async getCertificate(hostname: string): Promise<CertificateRecord | null> {
    const validatedHostname = validateHostname(hostname);
    const directory = path.join(
      this.#options.paths.importedCertificateDirectory,
      certificateKey(validatedHostname),
    );
    try {
      const record = JSON.parse(
        await readFile(path.join(directory, 'record.json'), 'utf8'),
      ) as CertificateRecord;
      if (
        record.hostname !== validatedHostname ||
        record.source !== 'imported' ||
        record.certificatePath !== path.join(directory, 'certificate.pem') ||
        record.keyPath !== path.join(directory, 'key.pem') ||
        record.chainPath !== path.join(directory, 'chain.pem')
      ) {
        return null;
      }
      const [certificatePem, keyPem] = await Promise.all([
        readFile(record.certificatePath),
        readFile(record.keyPath),
      ]);
      this.#validateCertificate(validatedHostname, certificatePem, keyPem);
      return record;
    } catch {
      return null;
    }
  }

  async listCertificates(): Promise<CertificateRecord[]> {
    await mkdir(this.#options.paths.importedCertificateDirectory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.#options.paths.importedCertificateDirectory, {
      withFileTypes: true,
    });
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(async (entry) => {
          try {
            const record = JSON.parse(
              await readFile(
                path.join(
                  this.#options.paths.importedCertificateDirectory,
                  entry.name,
                  'record.json',
                ),
                'utf8',
              ),
            ) as CertificateRecord;
            return this.getCertificate(record.hostname);
          } catch {
            return null;
          }
        }),
    );
    return records.filter((record): record is CertificateRecord => record !== null);
  }

  async removeCertificate(hostname: string): Promise<boolean> {
    const validatedHostname = validateHostname(hostname);
    const record = await this.getCertificate(validatedHostname);
    if (!record) {
      return false;
    }
    const directory = path.dirname(record.certificatePath);
    if (path.basename(directory) !== certificateKey(validatedHostname)) {
      throw new Error('Imported certificate record points outside its exact-host directory.');
    }
    await rm(directory, { recursive: true, force: true });
    return true;
  }

  async createSecureContext(hostname: string): Promise<SecureContext> {
    return createSecureContext(await this.readSecureContextOptions(hostname));
  }

  async readSecureContextOptions(hostname: string): Promise<CertificateContextOptions> {
    const record = await this.getCertificate(hostname);
    if (!record) {
      throw new Error(`No valid imported certificate exists for ${hostname}.`);
    }
    const [key, chain] = await Promise.all([readFile(record.keyPath), readFile(record.chainPath)]);
    return { key, cert: chain };
  }

  #validateCertificate(
    hostname: string,
    certificatePem: Buffer,
    privateKeyPem: Buffer,
  ): X509Certificate {
    const certificate = new X509Certificate(certificatePem);
    const now = (this.#options.now ?? (() => new Date()))().getTime();
    if (certificate.ca) {
      throw new Error('Imported server certificate must not be a CA certificate.');
    }
    if (
      certificate.subjectAltName !== `DNS:${hostname}` ||
      certificate.checkHost(hostname) !== hostname
    ) {
      throw new Error(`Imported certificate must contain exactly DNS:${hostname} as its SAN.`);
    }
    if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
      throw new Error(`Imported certificate for ${hostname} is not currently valid.`);
    }
    if (!publicKeysMatch(certificate, privateKeyPem)) {
      throw new Error(`Imported private key does not match the certificate for ${hostname}.`);
    }
    return certificate;
  }
}
