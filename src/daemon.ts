import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
import { dropServicePrivileges, transferServiceOwnership } from './service-privileges.js';
import { ensureStatePaths } from './state-paths.js';

export const SERVICE_BOOTSTRAP_HOSTNAME = 'unconfigured.vite-local-tls.invalid';

export class LocalTlsDaemon {
  readonly registry = new RouteRegistry();
  readonly #options: DaemonOptions;
  readonly #importStore: CertificateImportStore;
  readonly #certificateManager: CertificateManager;
  readonly #pendingHostnames = new Set<string>();
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
        hostname === SERVICE_BOOTSTRAP_HOSTNAME ||
        this.registry.get(hostname) !== undefined ||
        this.#pendingHostnames.has(hostname),
    });
  }

  get state(): ServiceState | null {
    return this.#state;
  }

  async start(): Promise<ServiceState> {
    if (this.#state) {
      return this.#state;
    }
    await ensureStatePaths(this.#options.paths);
    if (this.#options.runAsUser) {
      const transferOwnership = this.#options.transferOwnership ?? transferServiceOwnership;
      await transferOwnership(this.#options.runAsUser, [
        this.#options.paths.stateDirectory,
        path.dirname(this.#options.paths.runtimeDirectory),
        this.#options.paths.runtimeDirectory,
        this.#options.paths.certificateDirectory,
        this.#options.paths.importedCertificateDirectory,
      ]);
    }
    const authority = await this.#certificateManager.ensureCertificateAuthority();
    const bootstrap = await this.#certificateManager.ensureLeafCertificate(
      SERVICE_BOOTSTRAP_HOSTNAME,
    );
    const [bootstrapKey, bootstrapCertificate] = await Promise.all([
      readFile(bootstrap.keyPath),
      readFile(bootstrap.chainPath),
    ]);
    if (this.#options.runAsUser) {
      const transferOwnership = this.#options.transferOwnership ?? transferServiceOwnership;
      await transferOwnership(this.#options.runAsUser, [
        this.#options.paths.stateDirectory,
        path.dirname(this.#options.paths.runtimeDirectory),
        this.#options.paths.runtimeDirectory,
        this.#options.paths.lockPath,
        this.#options.paths.stateFile,
        this.#options.paths.certificateDirectory,
        this.#options.paths.importedCertificateDirectory,
        authority.certificatePath,
        authority.keyPath,
        this.#options.paths.caStatePath,
        bootstrap.certificatePath,
        bootstrap.keyPath,
        bootstrap.chainPath,
      ]);
    }
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
          }),
      });
      if (this.#options.runAsUser) {
        const dropPrivileges = this.#options.dropPrivileges ?? dropServicePrivileges;
        await dropPrivileges(this.#options.runAsUser, []);
      }
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
      this.#pendingHostnames.add(route.hostname);
    }
    try {
      const prepared = await Promise.all(
        routes.map(async (route) => {
          const imported = await this.#importStore.getCertificate(route.hostname);
          let policy: ReturnType<typeof resolveCertificatePolicy>;
          try {
            policy = resolveCertificatePolicy(route.hostname, route.internalTls, imported !== null);
          } catch (error) {
            throw new ControlProtocolError(
              'CERTIFICATE_REQUIRED',
              error instanceof Error ? error.message : String(error),
            );
          }
          return {
            hostname: route.hostname,
            context:
              policy === 'imported'
                ? await this.#importStore.readSecureContextOptions(route.hostname)
                : await this.#certificateManager.readSecureContextOptions(route.hostname),
          };
        }),
      );
      if (!this.#listeners?.ipv4.addContext || !this.#listeners.ipv6.addContext) {
        throw new Error('TLS listeners are unavailable during route validation.');
      }
      for (const { hostname, context } of prepared) {
        this.#listeners.ipv4.addContext(hostname, context);
        this.#listeners.ipv6.addContext(hostname, context);
      }
    } finally {
      for (const route of routes) {
        this.#pendingHostnames.delete(route.hostname);
      }
    }
  }
}
