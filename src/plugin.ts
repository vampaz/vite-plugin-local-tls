import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Plugin, PluginOption, PreviewServer, UserConfig, ViteDevServer } from 'vite';
import { CertificateManager } from './certificates.js';
import { ControlClient, type OwnedRouteInput } from './control-client.js';
import {
  normalizeBaseDomain,
  normalizeDomains,
  resolveLocalTlsDomains,
  sanitizeDomainLabel,
} from './domain-resolution.js';
import { getGitRepoInfo } from './checkout-resolution.js';
import type { LocalTlsPluginOptions } from './interfaces/plugin-options.js';
import type {
  PluginControlClient,
  PluginRuntimeDependencies,
} from './interfaces/plugin-runtime.js';
import type { ServiceInstallOptions } from './interfaces/service-install-options.js';
import type { StatePaths } from './interfaces/state-paths.js';
import { migrateLegacyCertificateState } from './legacy-certificate-migration.js';
import { LocalTlsService } from './service.js';
import {
  getStartupServiceUpdateStatus,
  installStartupService,
  replaceStartupService,
  startOwnedStartupService,
  startStartupService,
} from './service-install.js';
import { discoverStartupServiceInstallations } from './service-installation-discovery.js';
import { getStatePaths } from './state-paths.js';
import { ensureStartupServiceLifecycle } from './startup-service-lifecycle.js';
import { assertTlsSystemRequirements, inspectSystemRequirements } from './system-requirements.js';
import { TrustStore } from './trust-store.js';

type SupportedViteServer = ViteDevServer | PreviewServer;
export const PLUGIN_HEARTBEAT_INTERVAL_MS = 10_000;

function createConfig(
  userConfig: UserConfig,
  options: LocalTlsPluginOptions,
): Pick<UserConfig, 'server' | 'preview'> {
  const defaultHmrDomain = resolveLocalTlsDomains(options)?.[0];
  const hmr =
    userConfig.server?.hmr === undefined && defaultHmrDomain
      ? {
          protocol: 'wss' as const,
          host: defaultHmrDomain,
          clientPort: 443,
        }
      : userConfig.server?.hmr;
  return {
    server: {
      host: userConfig.server?.host === undefined ? true : userConfig.server.host,
      allowedHosts:
        userConfig.server?.allowedHosts === undefined ? true : userConfig.server.allowedHosts,
      ...(hmr !== undefined ? { hmr } : {}),
    },
    preview: {
      host: userConfig.preview?.host === undefined ? true : userConfig.preview.host,
      allowedHosts:
        userConfig.preview?.allowedHosts === undefined ? true : userConfig.preview.allowedHosts,
    },
  };
}

function createDefaultDependencies(): PluginRuntimeDependencies {
  const logger: PluginRuntimeDependencies['logger'] = {
    info(message): void {
      console.log(message);
    },
    warn(message): void {
      console.warn(message);
    },
    error(message, error): void {
      if (error === undefined) {
        console.error(message);
      } else {
        console.error(message, error);
      }
    },
  };
  return {
    platform: process.platform,
    infrastructureMode: 'canonical',
    logger,
    createControlClient(options): PluginControlClient {
      return new ControlClient(options);
    },
    async ensureInfrastructure(
      request,
    ): Promise<Awaited<ReturnType<typeof ensureStartupServiceLifecycle>>> {
      const requirements = inspectSystemRequirements();
      assertTlsSystemRequirements(requirements);
      const opensslPath = requirements.opensslPath!;
      const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
      const serviceInstallOptions = {
        namespace: request.namespace,
        paths: request.paths,
        nodePath: process.execPath,
        cliPath,
        readinessCliPath: cliPath,
        controlSocket: request.controlSocket,
      };
      async function discover() {
        return discoverStartupServiceInstallations({
          platform: process.platform,
          environment: process.env,
          nodePath: process.execPath,
          cliPath,
        });
      }
      function createService(paths: StatePaths, namespace: string): LocalTlsService {
        return new LocalTlsService({ paths, opensslPath, namespace, port: 443 });
      }
      async function ensureService(
        paths: StatePaths,
        namespace: string,
        serviceOptions: Pick<
          Parameters<LocalTlsService['autoStart']>[0],
          'isServiceCurrent' | 'installService'
        >,
      ) {
        const manager = new CertificateManager({ paths, opensslPath });
        const authority = await manager.ensureCertificateAuthority();
        const trustStore = new TrustStore({ requirements, authority });
        return createService(paths, namespace).autoStart({
          onAuthorizationWait(): void {
            logger.info(
              'Waiting for another Vite process to finish local TLS administrator authorization...',
            );
          },
          async isTrusted(): Promise<boolean> {
            return (await trustStore.verify()).trusted;
          },
          async trust(): Promise<void> {
            await trustStore.install();
          },
          ...serviceOptions,
        });
      }
      const result = await ensureStartupServiceLifecycle({
        canonicalNamespace: request.namespace,
        canonicalPaths: request.paths,
        discover,
        async status(installation) {
          return createService(installation.paths, installation.record.namespace).status();
        },
        async ensureLegacy(installation) {
          return ensureService(installation.paths, installation.record.namespace, {
            async isServiceCurrent(): Promise<boolean> {
              return (
                await createService(installation.paths, installation.record.namespace).status()
              ).running;
            },
            async installService(): Promise<void> {
              await startOwnedStartupService(installation.options);
            },
          });
        },
        async ensureCanonical({ installService }) {
          const inventory = await discover();
          if (inventory.legacy.length > 0) {
            const migration = await migrateLegacyCertificateState({
              canonicalPaths: request.paths,
              legacyInstallations: inventory.legacy,
              opensslPath,
              async isAuthorityTrusted(authority): Promise<boolean> {
                return (await new TrustStore({ requirements, authority }).verify()).trusted;
              },
            });
            if (migration.authorityNamespace) {
              logger.info(
                `Preserved the local TLS authority from legacy service ${migration.authorityNamespace}.`,
              );
            }
            if (migration.importedHostnames.length > 0) {
              logger.info(
                `Preserved imported TLS certificates for ${migration.importedHostnames.join(', ')}.`,
              );
            }
            if (migration.conflicts.length > 0) {
              logger.warn(
                `Kept canonical imported certificates for ${migration.conflicts.join(', ')} because legacy services contained different certificates for the same hostnames.`,
              );
            }
          }
          return ensureService(request.paths, request.namespace, {
            async isServiceCurrent(): Promise<boolean> {
              const inventory = await discover();
              if (inventory.legacy.length > 0) {
                return false;
              }
              const updateStatus = await getStartupServiceUpdateStatus(serviceInstallOptions);
              if (updateStatus !== 'newer') {
                return updateStatus === 'absent' || updateStatus === 'current';
              }
              const status = await createService(request.paths, request.namespace).status();
              return status.running && status.compatible;
            },
            installService,
          });
        },
        async converge(installations, source) {
          if (source && source.record.version !== 2) {
            throw new Error('Refusing to promote a legacy runtime without version metadata.');
          }
          let convergenceOptions: ServiceInstallOptions = serviceInstallOptions;
          if (source?.record.version === 2) {
            convergenceOptions = {
              ...serviceInstallOptions,
              nodePath: source.record.nodePath,
              cliPath: source.record.cliPath,
              currentVersion: source.record.packageVersion,
            };
          }
          const updateStatus = await getStartupServiceUpdateStatus(convergenceOptions);
          if (updateStatus === 'newer-incompatible') {
            throw new Error(
              'A newer installed local TLS service uses an incompatible control protocol. Update this project to that plugin version before starting it.',
            );
          }
          if (updateStatus === 'current' || updateStatus === 'newer') {
            await startStartupService(
              convergenceOptions,
              installations.map(({ options }) => options),
            );
            return;
          }
          if (installations.length > 0) {
            await replaceStartupService(
              convergenceOptions,
              installations.map(({ options }) => options),
            );
            return;
          }
          await installStartupService(convergenceOptions);
        },
      });
      for (const invalid of result.invalidInstallations) {
        logger.warn(
          `Ignored unsafe local TLS startup-service installation ${invalid.namespace}: ${invalid.message} Run \`vite-local-tls doctor\` for repair details.`,
        );
      }
      return result;
    },
  };
}

function resolveCompatibilityOptions(
  options: LocalTlsPluginOptions,
  dependencies: PluginRuntimeDependencies,
): LocalTlsPluginOptions {
  if (options.caddyApiUrl !== undefined) {
    dependencies.logger.warn(
      '`caddyApiUrl` is deprecated and ignored because the local TLS service has no HTTP Admin API. Alternate control channels are limited to explicitly injected test infrastructure.',
    );
  }
  if (options.caddyAdminOrigin !== undefined) {
    dependencies.logger.warn(
      '`caddyAdminOrigin` is deprecated and ignored because the local TLS service has no HTTP Admin API.',
    );
  }
  const compatibleOptions = {
    ...options,
    serviceNamespace: options.serviceNamespace ?? options.serverName,
  };
  if (dependencies.infrastructureMode !== 'canonical') {
    return compatibleOptions;
  }
  if (
    compatibleOptions.serviceNamespace !== undefined &&
    compatibleOptions.serviceNamespace !== 'default'
  ) {
    dependencies.logger.warn(
      '`serviceNamespace` no longer creates a separate port-443 service. The machine-wide canonical service is used to prevent startup collisions.',
    );
  }
  if (compatibleOptions.controlSocket !== undefined) {
    dependencies.logger.warn(
      '`controlSocket` is ignored by the ordinary plugin runtime because the machine-wide port-443 service has one canonical control channel.',
    );
  }
  return {
    ...compatibleOptions,
    serviceNamespace: 'default',
    controlSocket: undefined,
  };
}

function buildDomainResolutionMessage(options: LocalTlsPluginOptions): string {
  const issues: string[] = [];
  if (options.domain !== undefined && !normalizeDomains(options.domain)) {
    issues.push('`domain` is empty after trimming');
  }
  if (options.baseDomain !== undefined && !normalizeBaseDomain(options.baseDomain)) {
    issues.push('`baseDomain` is empty after trimming');
  }
  if (options.instanceLabel !== undefined && !sanitizeDomainLabel(options.instanceLabel)) {
    issues.push('`instanceLabel` is empty after sanitization');
  }
  const checkout = getGitRepoInfo();
  if (!(options.repo ?? checkout.repo)) {
    issues.push('repo name not found (not a git repo?)');
  }
  if (!(options.branch ?? checkout.branch)) {
    issues.push('branch name not found (detached HEAD?)');
  }
  return issues.length === 0
    ? 'No domain resolved. Provide `domain`, or `repo` and `branch`, or ensure git metadata is available.'
    : `No domain resolved. Issues: ${issues.join('; ')}. Provide \`domain\`, or \`repo\` and \`branch\`, or ensure git metadata is available.`;
}

function resolvePaths(options: LocalTlsPluginOptions): StatePaths {
  const paths = getStatePaths(options.serviceNamespace ?? 'default');
  return options.controlSocket ? { ...paths, socketPath: options.controlSocket } : paths;
}

function loopbackHost(host: string): string {
  if (host === '0.0.0.0') {
    return '127.0.0.1';
  }
  if (host === '::' || host === '[::]') {
    return '::1';
  }
  return host === 'localhost' ? '127.0.0.1' : host;
}

function configuredHost(host: string | boolean | undefined): string {
  if (typeof host === 'string' && host.trim()) {
    return loopbackHost(host.trim());
  }
  return '127.0.0.1';
}

function formatTarget(host: string, port: number): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]:${port}` : `${host}:${port}`;
}

function resolveUpstream(
  server: SupportedViteServer,
  preview: boolean,
): {
  host: string;
  port: number;
} {
  const resolvedUrl = server.resolvedUrls?.local?.[0];
  if (resolvedUrl) {
    try {
      const url = new URL(resolvedUrl);
      const port = Number(url.port);
      if (url.hostname && Number.isInteger(port) && port > 0) {
        return { host: loopbackHost(url.hostname), port };
      }
    } catch {}
  }
  const address = server.httpServer?.address();
  const configured = preview ? server.config.preview : server.config.server;
  const fallbackPort = preview
    ? (server.config.preview.port ?? 4173)
    : (server.config.server.port ?? 5173);
  if (address && typeof address !== 'string') {
    return {
      host: loopbackHost((address as AddressInfo).address || configuredHost(configured.host)),
      port: address.port,
    };
  }
  return { host: configuredHost(configured.host), port: fallbackPort };
}

function hasListen(server: SupportedViteServer): server is SupportedViteServer & {
  listen: (port?: number, isRestart?: boolean) => Promise<unknown>;
} {
  return 'listen' in server && typeof server.listen === 'function';
}

function createPlugin(
  options: LocalTlsPluginOptions,
  dependencies: PluginRuntimeDependencies,
): Plugin {
  const domains = resolveLocalTlsDomains(options) ?? [];

  function setupServer(server: SupportedViteServer, preview: boolean): void {
    if (domains.length === 0) {
      dependencies.logger.error(buildDomainResolutionMessage(options));
      return;
    }
    let started = false;
    let client: PluginControlClient | null = null;
    let cleanupPromise: Promise<void> | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    let recoveryPromise: Promise<void> | null = null;
    let shuttingDown = false;
    let ownerToken: string | undefined;
    let routeInputs: OwnedRouteInput[] = [];
    const ownedHostnames = new Set(domains);
    const namespace = options.serviceNamespace ?? 'default';
    const requestedPaths = resolvePaths(options);
    let activePaths = requestedPaths;

    function useInfrastructureResult(
      result: Awaited<ReturnType<PluginRuntimeDependencies['ensureInfrastructure']>>,
    ): void {
      activePaths = 'paths' in result ? result.paths : requestedPaths;
    }

    function delay(milliseconds: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    async function closeWithRetry(activeClient: PluginControlClient): Promise<void> {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await activeClient.close();
          return;
        } catch (error) {
          lastError = error;
          if (attempt < 2) {
            await delay(100 * 2 ** attempt);
          }
        }
      }
      dependencies.logger.error(
        `Failed to release local TLS routes for ${domains.join(', ')} after 3 attempts.`,
        lastError,
      );
    }

    async function cleanup(): Promise<void> {
      if (cleanupPromise) {
        return cleanupPromise;
      }
      cleanupPromise = (async () => {
        shuttingDown = true;
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
        const activeClient = client;
        if (activeClient) {
          await closeWithRetry(activeClient);
        }
        client = null;
      })();
      return cleanupPromise;
    }

    function signalExitCode(signal: NodeJS.Signals): number {
      return signal === 'SIGINT' ? 130 : 143;
    }

    function handleSignal(signal: NodeJS.Signals): void {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      void cleanup().finally(() => process.exit(signalExitCode(signal)));
    }

    function onSigint(): void {
      handleSignal('SIGINT');
    }

    function onSigterm(): void {
      handleSignal('SIGTERM');
    }

    function startHeartbeat(): void {
      heartbeat = setInterval(() => {
        const activeClient = client;
        if (!activeClient) {
          return;
        }
        const requestedHostnames = activeClient.claimedHostnames;
        if (requestedHostnames.length === 0) {
          return;
        }
        void activeClient
          .heartbeat(requestedHostnames)
          .then((activeHostnames) => {
            const active = new Set(activeHostnames);
            const lost = requestedHostnames.filter((hostname) => !active.has(hostname));
            if (lost.length > 0) {
              for (const hostname of lost) {
                ownedHostnames.delete(hostname);
              }
              dependencies.logger.error(
                `Lost local TLS route ownership for ${lost.join(', ')}; the Vite server is still running.`,
              );
            }
          })
          .catch((error: unknown) => {
            dependencies.logger.error(
              `Failed to refresh local TLS route ownership for ${requestedHostnames.join(', ')}.`,
              error,
            );
          });
      }, PLUGIN_HEARTBEAT_INTERVAL_MS);
      heartbeat.unref?.();
    }

    function createControlClient(): PluginControlClient {
      return dependencies.createControlClient({
        socketPath: activePaths.socketPath,
        ownerToken,
        onRouteLost(takeover): void {
          ownedHostnames.delete(takeover.hostname);
          dependencies.logger.error(
            `Lost local TLS route ownership for ${takeover.hostname}; a newer Vite server now owns that hostname.`,
          );
        },
        onDisconnect(): void {
          if (!shuttingDown) {
            void recoverRoutes();
          }
        },
      });
    }

    async function recoverRoutes(): Promise<void> {
      if (recoveryPromise || shuttingDown) {
        return recoveryPromise ?? Promise.resolve();
      }
      recoveryPromise = (async () => {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        let attempt = 0;
        while (!shuttingDown) {
          const activeRoutes = routeInputs.filter(({ hostname }) => ownedHostnames.has(hostname));
          if (activeRoutes.length === 0) {
            return;
          }
          let candidate: PluginControlClient | null = null;
          try {
            const infrastructure = await dependencies.ensureInfrastructure({
              namespace,
              paths: requestedPaths,
              controlSocket: options.controlSocket,
            });
            useInfrastructureResult(infrastructure);
            const recoverableRoutes = routeInputs.filter(({ hostname }) =>
              ownedHostnames.has(hostname),
            );
            if (recoverableRoutes.length === 0) {
              return;
            }
            candidate = createControlClient();
            await candidate.connect();
            await candidate.register(recoverableRoutes);
            if (shuttingDown) {
              await candidate.close();
              return;
            }
            client = candidate;
            dependencies.logger.info(
              `Recovered local TLS routes for ${recoverableRoutes.map(({ hostname }) => hostname).join(', ')}.`,
            );
            startHeartbeat();
            return;
          } catch (error) {
            attempt += 1;
            await candidate?.close().catch(() => undefined);
            if (shuttingDown) {
              return;
            }
            if (attempt === 3 || attempt % 12 === 0) {
              dependencies.logger.error(
                `Local TLS routes for ${[...ownedHostnames].join(', ')} are still unavailable; continuing to retry while the Vite server is running.`,
                error,
              );
            }
            await delay(Math.min(100 * 2 ** Math.min(attempt - 1, 4), 1600));
          }
        }
      })().finally(() => {
        recoveryPromise = null;
      });
      return recoveryPromise;
    }

    async function setup(): Promise<void> {
      if (started) {
        return;
      }
      started = true;
      const upstream = resolveUpstream(server, preview);
      routeInputs = domains.map((hostname) => ({
        hostname,
        upstreamHost: upstream.host,
        upstreamPort: upstream.port,
        ...(options.cors !== undefined ? { cors: options.cors } : {}),
        ...(options.internalTls !== undefined ? { internalTls: options.internalTls } : {}),
        ...(options.upstreamHostHeader !== undefined
          ? { upstreamHostHeader: options.upstreamHostHeader }
          : {}),
      }));
      try {
        const infrastructure = await dependencies.ensureInfrastructure({
          namespace,
          paths: requestedPaths,
          controlSocket: options.controlSocket,
        });
        useInfrastructureResult(infrastructure);
        const controlClient = createControlClient();
        ownerToken = controlClient.ownerToken;
        client = controlClient;
        await controlClient.connect();
        await controlClient.register(routeInputs);
      } catch (error) {
        await cleanup().catch(() => undefined);
        dependencies.logger.error(
          `Failed to register local TLS routes for ${domains.join(', ')}.`,
          error,
        );
        return;
      }
      dependencies.logger.info(
        `Local TLS upstream: http://${formatTarget(upstream.host, upstream.port)}`,
      );
      for (const hostname of domains) {
        dependencies.logger.info(`Local TLS URL: https://${hostname}`);
      }
      if (dependencies.platform === 'linux' && !options.loopbackDomain) {
        dependencies.logger.info(
          'Linux hostname guidance: use a .localhost domain or map the hostname to 127.0.0.1.',
        );
      }
      startHeartbeat();
      process.once('SIGINT', onSigint);
      process.once('SIGTERM', onSigterm);
      server.httpServer?.once('close', () => void cleanup());
    }

    function startSetup(): void {
      void setup();
    }

    if (server.httpServer?.listening) {
      startSetup();
      return;
    }
    if (server.httpServer) {
      server.httpServer.once('listening', startSetup);
    }
    if (hasListen(server)) {
      const originalListen = server.listen.bind(server);
      server.listen = async function listen(port?: number, isRestart?: boolean): Promise<unknown> {
        const result = await originalListen(port, isRestart);
        await setup();
        return result;
      };
    }
  }

  return {
    name: '@vampaz/vite-plugin-local-tls',
    config(userConfig): Pick<UserConfig, 'server' | 'preview'> {
      return createConfig(userConfig, options);
    },
    configureServer(server): void {
      setupServer(server, false);
    },
    configurePreviewServer(server): void {
      setupServer(server, true);
    },
  };
}

export function createViteLocalTlsPlugin(
  options: LocalTlsPluginOptions = {},
  dependencies: PluginRuntimeDependencies = createDefaultDependencies(),
): Plugin {
  return createPlugin(resolveCompatibilityOptions(options, dependencies), dependencies);
}

export function viteLocalTlsPlugin(options: LocalTlsPluginOptions = {}): PluginOption {
  return createViteLocalTlsPlugin(options);
}
