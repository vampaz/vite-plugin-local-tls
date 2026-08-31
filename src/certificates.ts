import { execFile } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  X509Certificate,
} from 'node:crypto';
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSecureContext, type SecureContext } from 'node:tls';
import { validateHostname } from './control-protocol.js';
import type { CertificateContextOptions } from './interfaces/certificate-context-options.js';
import type { CertificateManagerOptions } from './interfaces/certificate-manager-options.js';
import type {
  CertificateAuthorityRecord,
  CertificateRecord,
} from './interfaces/certificate-record.js';
import { ensurePersistentStatePaths } from './state-paths.js';

const CA_VALIDITY_DAYS = 3650;
const EXPIRATION_WARNING_MS = 30 * 24 * 60 * 60 * 1000;
const LEAF_RENEWAL_MS = 7 * 24 * 60 * 60 * 1000;
const LEAF_VALIDITY_DAYS = 30;
const AUTHORITY_LOCK_STALE_MS = 30_000;
const AUTHORITY_LOCK_TIMEOUT_MS = 30_000;
const AUTHORITY_LOCK_RETRY_MS = 25;
const EC_PUBLIC_KEY_OID = Buffer.from('06072a8648ce3d0201', 'hex');
const BOOT_TIME_TOLERANCE_MS = 1_000;

interface AuthorityLock {
  pid: number;
  startedAt: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function execute(command: string, arguments_: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, arguments_, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`OpenSSL failed: ${stderr.trim() || error.message}`, { cause: error }));
        return;
      }
      resolve();
    });
  });
}

function publicKeysMatch(certificate: X509Certificate, privateKeyPem: Buffer): boolean {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicFromPrivate = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const certificatePublicKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
  return Buffer.from(publicFromPrivate).equals(Buffer.from(certificatePublicKey));
}

function usesNamedEcParameters(certificate: X509Certificate): boolean {
  const publicKey = Buffer.from(certificate.publicKey.export({ type: 'spki', format: 'der' }));
  const algorithmOffset = publicKey.indexOf(EC_PUBLIC_KEY_OID);
  return algorithmOffset >= 0 && publicKey[algorithmOffset + EC_PUBLIC_KEY_OID.length] === 0x06;
}

function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.replaceAll(':', '').toLowerCase();
}

export class CertificateManager {
  readonly #options: CertificateManagerOptions;
  readonly #leafPromises = new Map<string, Promise<CertificateRecord>>();
  #authorityPromise: Promise<CertificateAuthorityRecord> | null = null;

  constructor(options: CertificateManagerOptions) {
    this.#options = options;
  }

  ensureCertificateAuthority(): Promise<CertificateAuthorityRecord> {
    this.#authorityPromise ??= this.#ensureCertificateAuthority();
    return this.#authorityPromise.catch((error) => {
      this.#authorityPromise = null;
      throw error;
    });
  }

  ensureLeafCertificate(hostname: string): Promise<CertificateRecord> {
    const validatedHostname = validateHostname(hostname);
    if (!this.#options.isHostnameRegistered?.(validatedHostname)) {
      return Promise.reject(
        new Error(
          `Refusing to issue a certificate for unregistered hostname: ${validatedHostname}`,
        ),
      );
    }
    const existingPromise = this.#leafPromises.get(validatedHostname);
    if (existingPromise) {
      return existingPromise;
    }
    const promise = this.#ensureLeafCertificate(validatedHostname).finally(() => {
      this.#leafPromises.delete(validatedHostname);
    });
    this.#leafPromises.set(validatedHostname, promise);
    return promise;
  }

  async createSecureContext(hostname: string): Promise<SecureContext> {
    return createSecureContext(await this.readSecureContextOptions(hostname));
  }

  async readSecureContextOptions(hostname: string): Promise<CertificateContextOptions> {
    const record = await this.ensureLeafCertificate(hostname);
    const [key, certificate] = await Promise.all([
      readFile(record.keyPath),
      readFile(record.chainPath),
    ]);
    return { key, cert: certificate };
  }

  async #ensureCertificateAuthority(): Promise<CertificateAuthorityRecord> {
    await ensurePersistentStatePaths(this.#options.paths);
    return this.#withAuthorityLock(async () => {
      const certificateExists = await stat(this.#options.paths.caCertificatePath)
        .then(() => true)
        .catch(() => false);
      const keyExists = await stat(this.#options.paths.caKeyPath)
        .then(() => true)
        .catch(() => false);
      if (certificateExists !== keyExists) {
        throw new Error(
          'The local CA is incomplete. Refusing to overwrite it; run `vite-local-tls clean --ca` after removing trust for the old CA.',
        );
      }
      if (!certificateExists) {
        await this.#generateCertificateAuthority();
      }
      return this.#readCertificateAuthority();
    });
  }

  async #withAuthorityLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.#options.paths.caStatePath}.lock`;
    const deadline = Date.now() + AUTHORITY_LOCK_TIMEOUT_MS;
    while (true) {
      const handle = await open(lockPath, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') {
          return null;
        }
        throw error;
      });
      if (handle) {
        try {
          const lock: AuthorityLock = {
            pid: process.pid,
            startedAt: new Date().toISOString(),
          };
          await handle.writeFile(`${JSON.stringify(lock)}\n`);
          return await operation();
        } finally {
          await handle.close();
          await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') {
              throw error;
            }
          });
        }
      }
      const stale = await Promise.all([readFile(lockPath, 'utf8'), lstat(lockPath)])
        .then(([contents, stats]) => {
          if (!stats.isFile()) {
            return true;
          }
          let lock: AuthorityLock | null = null;
          try {
            const value = JSON.parse(contents) as Partial<AuthorityLock>;
            if (
              Number.isSafeInteger(value.pid) &&
              Number(value.pid) > 0 &&
              typeof value.startedAt === 'string' &&
              Number.isFinite(Date.parse(value.startedAt))
            ) {
              lock = value as AuthorityLock;
            }
          } catch {
            lock = null;
          }
          const pid = lock?.pid ?? Number(contents.trim());
          const bootBoundary = Date.now() - os.uptime() * 1_000 - BOOT_TIME_TOLERANCE_MS;
          const predatesBoot = lock
            ? Date.parse(lock.startedAt) < bootBoundary
            : stats.mtimeMs < bootBoundary;
          if (predatesBoot) {
            return true;
          }
          return Number.isSafeInteger(pid) && pid > 0
            ? !isProcessRunning(pid)
            : Date.now() - stats.mtimeMs > AUTHORITY_LOCK_STALE_MS;
        })
        .catch((lockError: NodeJS.ErrnoException) => lockError.code === 'ENOENT');
      if (stale) {
        await unlink(lockPath).catch((lockError: NodeJS.ErrnoException) => {
          if (lockError.code !== 'ENOENT') {
            throw lockError;
          }
        });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the local CA lock at ${lockPath}.`);
      }
      await delay(AUTHORITY_LOCK_RETRY_MS);
    }
  }

  async #generateCertificateAuthority(): Promise<void> {
    const temporaryDirectory = await mkdtemp(path.join(this.#options.paths.stateDirectory, '.ca-'));
    const temporaryKeyPath = path.join(temporaryDirectory, 'ca-key.pem');
    const temporaryCertificatePath = path.join(temporaryDirectory, 'ca.pem');
    try {
      await execute(this.#options.opensslPath, [
        'req',
        '-x509',
        '-new',
        '-nodes',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-pkeyopt',
        'ec_param_enc:named_curve',
        '-keyout',
        temporaryKeyPath,
        '-out',
        temporaryCertificatePath,
        '-sha256',
        '-days',
        String(CA_VALIDITY_DAYS),
        '-subj',
        '/CN=Vite Local TLS Development CA',
        '-addext',
        'basicConstraints=critical,CA:TRUE,pathlen:0',
        '-addext',
        'keyUsage=critical,keyCertSign,cRLSign',
        '-addext',
        'subjectKeyIdentifier=hash',
      ]);
      await chmod(temporaryKeyPath, 0o600);
      await chmod(temporaryCertificatePath, 0o644);
      await rename(temporaryKeyPath, this.#options.paths.caKeyPath);
      await rename(temporaryCertificatePath, this.#options.paths.caCertificatePath);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async #readCertificateAuthority(): Promise<CertificateAuthorityRecord> {
    const [certificatePem, privateKeyPem] = await Promise.all([
      readFile(this.#options.paths.caCertificatePath),
      readFile(this.#options.paths.caKeyPath),
    ]);
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(certificatePem);
    } catch (error) {
      throw new Error('The local CA certificate is invalid and was not overwritten.', {
        cause: error,
      });
    }
    if (!certificate.ca) {
      throw new Error('The stored local CA certificate is missing CA constraints.');
    }
    if (!usesNamedEcParameters(certificate)) {
      throw new Error(
        'The stored local CA uses incompatible explicit EC parameters. Remove its trust and run `vite-local-tls clean --ca` before regenerating it.',
      );
    }
    if (!publicKeysMatch(certificate, privateKeyPem)) {
      throw new Error('The stored local CA key does not match its certificate.');
    }
    const now = (this.#options.now ?? (() => new Date()))().getTime();
    const validTo = Date.parse(certificate.validTo);
    if (!Number.isFinite(validTo) || validTo <= now) {
      throw new Error(
        'The local CA has expired. Remove its trust and run `vite-local-tls clean --ca` before regenerating it.',
      );
    }
    if (process.platform !== 'win32') {
      await chmod(this.#options.paths.caKeyPath, 0o600);
    }
    const record: CertificateAuthorityRecord = {
      certificatePath: this.#options.paths.caCertificatePath,
      keyPath: this.#options.paths.caKeyPath,
      fingerprint: normalizeFingerprint(certificate.fingerprint256),
      fingerprintSha1: normalizeFingerprint(certificate.fingerprint),
      validFrom: new Date(certificate.validFrom).toISOString(),
      validTo: new Date(certificate.validTo).toISOString(),
      expiresSoon: validTo - now <= EXPIRATION_WARNING_MS,
    };
    const temporaryStatePath = `${this.#options.paths.caStatePath}.${process.pid}.tmp`;
    await writeFile(temporaryStatePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryStatePath, this.#options.paths.caStatePath);
    return record;
  }

  async #ensureLeafCertificate(hostname: string): Promise<CertificateRecord> {
    const authority = await this.ensureCertificateAuthority();
    const key = createHash('sha256').update(hostname).digest('hex');
    const certificatePath = path.join(this.#options.paths.certificateDirectory, `${key}.pem`);
    const keyPath = path.join(this.#options.paths.certificateDirectory, `${key}-key.pem`);
    const chainPath = path.join(this.#options.paths.certificateDirectory, `${key}-chain.pem`);
    const existing = await this.#readLeafCertificate(
      hostname,
      certificatePath,
      keyPath,
      chainPath,
      authority,
    );
    if (existing) {
      return existing;
    }
    await this.#generateLeafCertificate(hostname, certificatePath, keyPath, chainPath);
    const record = await this.#readLeafCertificate(
      hostname,
      certificatePath,
      keyPath,
      chainPath,
      authority,
    );
    if (!record) {
      throw new Error(`Generated certificate for ${hostname} failed validation.`);
    }
    return record;
  }

  async #readLeafCertificate(
    hostname: string,
    certificatePath: string,
    keyPath: string,
    chainPath: string,
    authority: CertificateAuthorityRecord,
  ): Promise<CertificateRecord | null> {
    try {
      const [certificatePem, privateKeyPem, authorityPem] = await Promise.all([
        readFile(certificatePath),
        readFile(keyPath),
        readFile(authority.certificatePath),
      ]);
      const certificate = new X509Certificate(certificatePem);
      const caCertificate = new X509Certificate(authorityPem);
      const now = (this.#options.now ?? (() => new Date()))().getTime();
      const validTo = Date.parse(certificate.validTo);
      if (
        certificate.ca ||
        !usesNamedEcParameters(certificate) ||
        certificate.checkHost(hostname) !== hostname ||
        !certificate.verify(caCertificate.publicKey) ||
        !publicKeysMatch(certificate, privateKeyPem) ||
        validTo - now <= LEAF_RENEWAL_MS
      ) {
        return null;
      }
      if (process.platform !== 'win32') {
        await chmod(keyPath, 0o600);
      }
      return {
        hostname,
        certificatePath,
        keyPath,
        chainPath,
        fingerprint: normalizeFingerprint(certificate.fingerprint256),
        validTo: new Date(certificate.validTo).toISOString(),
        source: 'local-ca',
      };
    } catch {
      return null;
    }
  }

  async #generateLeafCertificate(
    hostname: string,
    certificatePath: string,
    keyPath: string,
    chainPath: string,
  ): Promise<void> {
    const temporaryDirectory = await mkdtemp(
      path.join(this.#options.paths.certificateDirectory, '.leaf-'),
    );
    const temporaryKeyPath = path.join(temporaryDirectory, 'key.pem');
    const requestPath = path.join(temporaryDirectory, 'request.pem');
    const temporaryCertificatePath = path.join(temporaryDirectory, 'certificate.pem');
    const extensionPath = path.join(temporaryDirectory, 'extensions.cnf');
    const temporaryChainPath = path.join(temporaryDirectory, 'chain.pem');
    try {
      await writeFile(
        extensionPath,
        [
          'basicConstraints=critical,CA:FALSE',
          'keyUsage=critical,digitalSignature,keyEncipherment',
          'extendedKeyUsage=serverAuth',
          `subjectAltName=DNS:${hostname}`,
          '',
        ].join('\n'),
        { mode: 0o600 },
      );
      await execute(this.#options.opensslPath, [
        'req',
        '-new',
        '-nodes',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-pkeyopt',
        'ec_param_enc:named_curve',
        '-keyout',
        temporaryKeyPath,
        '-out',
        requestPath,
        '-subj',
        '/CN=Vite Local TLS',
        '-addext',
        `subjectAltName=DNS:${hostname}`,
      ]);
      await execute(this.#options.opensslPath, [
        'x509',
        '-req',
        '-in',
        requestPath,
        '-CA',
        this.#options.paths.caCertificatePath,
        '-CAkey',
        this.#options.paths.caKeyPath,
        '-set_serial',
        `0x${randomBytes(16).toString('hex')}`,
        '-out',
        temporaryCertificatePath,
        '-days',
        String(LEAF_VALIDITY_DAYS),
        '-sha256',
        '-extfile',
        extensionPath,
      ]);
      const [certificatePem, authorityPem] = await Promise.all([
        readFile(temporaryCertificatePath),
        readFile(this.#options.paths.caCertificatePath),
      ]);
      await writeFile(temporaryChainPath, Buffer.concat([certificatePem, authorityPem]), {
        mode: 0o644,
      });
      await chmod(temporaryKeyPath, 0o600);
      await rename(temporaryKeyPath, keyPath);
      await rename(temporaryCertificatePath, certificatePath);
      await rename(temporaryChainPath, chainPath);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

export function createSniCallback(manager: CertificateManager) {
  return function selectCertificate(
    hostname: string,
    callback: (error: Error | null, context?: SecureContext) => void,
  ): void {
    manager.createSecureContext(hostname).then(
      (context) => callback(null, context),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    );
  };
}
