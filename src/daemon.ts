import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import type { SecureContext } from 'node:tls';
import { CertificateImportStore } from './certificate-import.js';
import { resolveCertificatePolicy } from './certificate-policy.js';
import { CertificateManager } from './certificates.js';
import { CONTROL_PROTOCOL_VERSION, ControlProtocolError } from './control-protocol.js';
import { ControlServer } from './control-server.js';
import type { DaemonOptions } from './interfaces/daemon-options.js';
import type { ProxyListenerSet } from './interfaces/proxy-listeners.js';
import type { RouteRegistration } from './interfaces/route-registration.js';
import type { ServiceState } from './interfaces/service-state.js';
import { startProxyListeners } from './proxy-listeners.js';
import { createSecureProxyServer, ProxyServer } from './proxy-server.js';
import { RouteRegistry } from './route-registry.js';

const BOOTSTRAP_HOSTNAME = 'unconfigured.vite-local-tls.invalid';

export class LocalTlsDaemon {
  readonly registry = new RouteRegistry();
  readonly #options: DaemonOptions;
  readonly #importStore: CertificateImportStore;
  readonly #certificateManager: CertificateManager;
  #controlServer: ControlServer | null = null;
  #listeners: ProxyListenerSet | null = null;
  #state: ServiceState | null = null;

  constructor(options: DaemonOptions) {
    this.#options = options;
    this.#importStore = new CertificateImportStore({ paths: options.paths });
    this.#certificateManager = new CertificateManager({
      paths: options.paths,
      opensslPath: options.opensslPath,
      isHostnameRegistered: (hostname) =>
        hostname === BOOTSTRAP_HOSTNAME || this.registry.get(hostname) !== undefined,
    });
  }

  get state(): ServiceState | null {
    return this.#state;
  }

  async start(): Promise<ServiceState> {
    if (this.#state) {
      return this.#state;
    }
    const authority = await this.#certificateManager.ensureCertificateAuthority();
    const bootstrap = await this.#certificateManager.ensureLeafCertificate(BOOTSTRAP_HOSTNAME);
    const [bootstrapKey, bootstrapCertificate] = await Promise.all([
      readFile(bootstrap.keyPath),
      readFile(bootstrap.chainPath),
    ]);
    const proxy = new ProxyServer({
      registry: this.registry,
      publicPort: this.#options.port && this.#options.port > 0 ? this.#options.port : 443,
    });
    try {
      this.#listeners = await startProxyListeners({
        port: this.#options.port,
        createServer: () =>
          createSecureProxyServer(proxy, {
            key: bootstrapKey,
            cert: bootstrapCertificate,
            SNICallback: this.#selectCertificate.bind(this),
          }),
      });
      this.#controlServer = new ControlServer({
        socketPath: this.#options.paths.socketPath,
        registry: this.registry,
        validateRoutes: this.#validateRoutes.bind(this),
        onStopRequested: () => void this.stop(),
      });
      await this.#controlServer.start();
      const state: ServiceState = {
        version: 1,
        pid: process.pid,
        namespace: this.#options.namespace ?? 'default',
        socketPath: this.#options.paths.socketPath,
        startedAt: new Date().toISOString(),
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        port: this.#listeners.port,
        caFingerprint: authority.fingerprint,
      };
      const temporaryStatePath = `${this.#options.paths.stateFile}.${process.pid}.tmp`;
      await writeFile(temporaryStatePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryStatePath, this.#options.paths.stateFile);
      this.#state = state;
      return state;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const controlServer = this.#controlServer;
    const listeners = this.#listeners;
    this.#controlServer = null;
    this.#listeners = null;
    this.#state = null;
    await controlServer?.stop();
    await listeners?.close();
    await unlink(this.#options.paths.stateFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  }

  async #validateRoutes(routes: RouteRegistration[]): Promise<void> {
    for (const route of routes) {
      const imported = await this.#importStore.getCertificate(route.hostname);
      try {
        resolveCertificatePolicy(route.hostname, route.internalTls, imported !== null);
      } catch (error) {
        throw new ControlProtocolError(
          'CERTIFICATE_REQUIRED',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  #selectCertificate(
    hostname: string,
    callback: (error: Error | null, context?: SecureContext) => void,
  ): void {
    const route = this.registry.get(hostname);
    if (!route) {
      callback(new Error(`No active route owns SNI hostname ${hostname}.`));
      return;
    }
    this.#resolveSecureContext(route).then(
      (context) => callback(null, context),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    );
  }

  async #resolveSecureContext(route: RouteRegistration): Promise<SecureContext> {
    const imported = await this.#importStore.getCertificate(route.hostname);
    const policy = resolveCertificatePolicy(route.hostname, route.internalTls, imported !== null);
    return policy === 'imported'
      ? this.#importStore.createSecureContext(route.hostname)
      : this.#certificateManager.createSecureContext(route.hostname);
  }
}
