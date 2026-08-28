import { describe, expect, it, vi } from 'vitest';
import type {
  DiscoveredStartupServiceInstallation,
  StartupServiceInstallationInventory,
} from './interfaces/service-installation-inventory.js';
import type { ServiceState } from './interfaces/service-state.js';
import type { ServiceStatus } from './interfaces/service-status.js';
import type { StatePaths } from './interfaces/state-paths.js';
import { ensureStartupServiceLifecycle } from './startup-service-lifecycle.js';

const state: ServiceState = {
  version: 1,
  pid: 123,
  namespace: 'default',
  socketPath: '/tmp/default.sock',
  startedAt: '2026-08-28T00:00:00.000Z',
  protocolVersion: 1,
  port: 443,
  caFingerprint: 'fingerprint',
};

function paths(namespace: string): StatePaths {
  return {
    stateDirectory: `/state/${namespace}`,
    runtimeDirectory: `/run/${namespace}`,
    socketPath: `/run/${namespace}/control.sock`,
    lockPath: `/run/${namespace}/startup.lock`,
    stateFile: `/state/${namespace}/service.json`,
    certificateDirectory: `/state/${namespace}/certificates`,
    importedCertificateDirectory: `/state/${namespace}/imported`,
    caKeyPath: `/state/${namespace}/ca-key.pem`,
    caCertificatePath: `/state/${namespace}/ca.pem`,
    caStatePath: `/state/${namespace}/ca.json`,
  };
}

function installation(namespace: string): DiscoveredStartupServiceInstallation {
  const installationPaths = paths(namespace);
  return {
    recordPath: `${installationPaths.stateDirectory}/service-install.json`,
    paths: installationPaths,
    record: {
      version: 1,
      platform: 'linux',
      namespace,
      identifier: `vite-local-tls-${namespace}`,
      definitionPath: `/etc/systemd/system/vite-local-tls-${namespace}.service`,
      nodePath: `/state/${namespace}/service-runtime/node`,
      cliPath: `/state/${namespace}/service-runtime/cli-${namespace}.js`,
      runtimeDirectory: `/state/${namespace}/service-runtime`,
      controlSocket: null,
      installedAt: '2026-08-28T00:00:00.000Z',
    },
    options: {
      platform: 'linux',
      namespace,
      paths: installationPaths,
      nodePath: '/current/node',
      cliPath: '/current/cli.js',
    },
  };
}

function newerInstallation(
  namespace: string,
  protocolVersion = 1,
  packageVersion = '99.0.0',
): DiscoveredStartupServiceInstallation {
  const value = installation(namespace);
  value.record = {
    ...value.record,
    version: 2,
    packageVersion,
    protocolVersion,
    installationState: 'installed',
  };
  return value;
}

function inventory(
  ...legacy: DiscoveredStartupServiceInstallation[]
): StartupServiceInstallationInventory {
  return { canonical: null, legacy, invalid: [] };
}

function status(activeRoutes: number, compatible = true): ServiceStatus {
  return {
    running: true,
    activeRoutes,
    protocolVersion: compatible ? 1 : 0,
    compatible,
    state,
  };
}

describe('startup service lifecycle convergence', () => {
  it('adopts one compatible active legacy winner without interrupting its routes', async () => {
    const active = installation('playground');
    const discover = vi.fn(async () => inventory(active));
    const ensureLegacy = vi.fn(async () => ({ ...state, namespace: 'playground' }));
    const ensureCanonical = vi.fn(async () => state);
    const converge = vi.fn(async () => undefined);

    const result = await ensureStartupServiceLifecycle({
      canonicalNamespace: 'default',
      canonicalPaths: paths('default'),
      discover,
      status: async () => status(2),
      ensureLegacy,
      ensureCanonical,
      converge,
    });

    expect(result).toMatchObject({
      namespace: 'playground',
      paths: active.paths,
      adoptedLegacy: true,
    });
    expect(ensureLegacy).toHaveBeenCalledWith(active);
    expect(ensureCanonical).not.toHaveBeenCalled();
    expect(converge).not.toHaveBeenCalled();
  });

  it('adopts an active canonical record that still uses a legacy custom control channel', async () => {
    const customCanonical = installation('default');
    customCanonical.record.controlSocket = '/run/custom/control.sock';
    customCanonical.paths = {
      ...customCanonical.paths,
      socketPath: '/run/custom/control.sock',
    };
    const ensureLegacy = vi.fn(async () => state);
    const ensureCanonical = vi.fn(async () => state);

    const result = await ensureStartupServiceLifecycle({
      canonicalNamespace: 'default',
      canonicalPaths: paths('default'),
      discover: async () => ({ canonical: customCanonical, legacy: [], invalid: [] }),
      status: async () => status(1),
      ensureLegacy,
      ensureCanonical,
      converge: async () => undefined,
    });

    expect(result).toMatchObject({
      paths: customCanonical.paths,
      adoptedLegacy: true,
    });
    expect(ensureLegacy).toHaveBeenCalledWith(customCanonical);
    expect(ensureCanonical).not.toHaveBeenCalled();
  });

  it('reinstalls an idle canonical record that still uses a legacy custom control channel', async () => {
    const customCanonical = installation('default');
    customCanonical.record.controlSocket = '/run/custom/control.sock';
    customCanonical.paths = {
      ...customCanonical.paths,
      socketPath: '/run/custom/control.sock',
    };
    const converge = vi.fn(async () => undefined);

    await ensureStartupServiceLifecycle({
      canonicalNamespace: 'default',
      canonicalPaths: paths('default'),
      discover: async () => ({ canonical: customCanonical, legacy: [], invalid: [] }),
      status: async () => status(0),
      ensureLegacy: async () => state,
      async ensureCanonical({ updateRequired, installService }) {
        expect(updateRequired).toBe(true);
        await installService();
        return state;
      },
      converge,
    });

    expect(converge).toHaveBeenCalledWith([], undefined);
  });

  it('promotes one newer idle installation into the canonical service', async () => {
    const newer = newerInstallation('newer');
    const ensureLegacy = vi.fn(async () => state);
    const ensureCanonical = vi.fn(async ({ installService }) => {
      await installService();
      return state;
    });
    const converge = vi.fn(async () => undefined);

    const result = await ensureStartupServiceLifecycle({
      canonicalNamespace: 'default',
      canonicalPaths: paths('default'),
      discover: async () => inventory(newer),
      status: async () => ({
        running: false,
        activeRoutes: 0,
        protocolVersion: null,
        compatible: false,
        state: null,
      }),
      ensureLegacy,
      ensureCanonical,
      converge,
    });

    expect(result).toMatchObject({ namespace: 'default', adoptedLegacy: false });
    expect(ensureLegacy).not.toHaveBeenCalled();
    expect(ensureCanonical).toHaveBeenCalledOnce();
    expect(converge).toHaveBeenCalledWith([newer], newer);
  });

  it('keeps a compatible active canonical service instead of interrupting it for a newer legacy contender', async () => {
    const canonical = installation('default');
    const newer = newerInstallation('newer');
    const ensureLegacy = vi.fn(async (selected) => ({
      ...state,
      namespace: selected.record.namespace,
    }));

    const result = await ensureStartupServiceLifecycle({
      canonicalNamespace: 'default',
      canonicalPaths: paths('default'),
      discover: async () => ({ canonical, legacy: [newer], invalid: [] }),
      status: async (selected) =>
        selected === canonical
          ? status(1)
          : {
              running: false,
              activeRoutes: 0,
              protocolVersion: null,
              compatible: false,
              state: null,
            },
      ensureLegacy,
      ensureCanonical: async () => state,
      converge: async () => undefined,
    });

    expect(result).toMatchObject({
      namespace: 'default',
      adoptedLegacy: false,
    });
    expect(ensureLegacy).toHaveBeenCalledOnce();
    expect(ensureLegacy).toHaveBeenCalledWith(canonical);
  });

  it('promotes the highest compatible newer installation discovered under the final check', async () => {
    const olderNewer = newerInstallation('newer', 1, '98.0.0');
    const newest = newerInstallation('newest', 1, '100.0.0');
    const converge = vi.fn(async () => undefined);

    await ensureStartupServiceLifecycle({
      canonicalNamespace: 'default',
      canonicalPaths: paths('default'),
      discover: async () => inventory(olderNewer, newest),
      status: async () => ({
        running: false,
        activeRoutes: 0,
        protocolVersion: null,
        compatible: false,
        state: null,
      }),
      ensureLegacy: async () => state,
      async ensureCanonical({ installService }) {
        await installService();
        return state;
      },
      converge,
    });

    expect(converge).toHaveBeenCalledWith([olderNewer, newest], newest);
  });

  it('refuses to choose between two owned services that both report active routes', async () => {
    const canonical = installation('default');
    const legacy = installation('playground');

    await expect(
      ensureStartupServiceLifecycle({
        canonicalNamespace: 'default',
        canonicalPaths: paths('default'),
        discover: async () => ({ canonical, legacy: [legacy], invalid: [] }),
        status: async () => status(1),
        ensureLegacy: async () => state,
        ensureCanonical: async () => state,
        converge: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'MULTIPLE_ACTIVE_SERVICES' });
  });

  it('leaves a newer incompatible installation untouched and requests a matching client', async () => {
    const newer = newerInstallation('future', 2);

    await expect(
      ensureStartupServiceLifecycle({
        canonicalNamespace: 'default',
        canonicalPaths: paths('default'),
        discover: async () => inventory(newer),
        status: async () => ({
          running: false,
          activeRoutes: 0,
          protocolVersion: null,
          compatible: false,
          state: null,
        }),
        ensureLegacy: async () => state,
        ensureCanonical: async () => state,
        converge: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'NEWER_SERVICE_INCOMPATIBLE' });
  });

  it('converges every idle owned legacy service before using the canonical service', async () => {
    const first = installation('first');
    const second = installation('second');
    const discover = vi.fn(async () => inventory(first, second));
    const converge = vi.fn(async () => undefined);
    const ensureCanonical = vi.fn(async ({ updateRequired, installService }) => {
      expect(updateRequired).toBe(true);
      await installService();
      return state;
    });

    const result = await ensureStartupServiceLifecycle({
      canonicalNamespace: 'default',
      canonicalPaths: paths('default'),
      discover,
      status: async () => status(0),
      ensureLegacy: async () => state,
      ensureCanonical,
      converge,
    });

    expect(result).toMatchObject({ namespace: 'default', adoptedLegacy: false });
    expect(converge).toHaveBeenCalledWith([first, second], undefined);
  });

  it('rechecks all routes under the installation lock and refuses a racing takeover', async () => {
    const legacy = installation('racing');
    let discoveryCount = 0;
    const discover = vi.fn(async () => {
      discoveryCount += 1;
      return inventory(legacy);
    });
    const statusCheck = vi.fn().mockResolvedValueOnce(status(0)).mockResolvedValueOnce(status(1));
    const converge = vi.fn(async () => undefined);

    await expect(
      ensureStartupServiceLifecycle({
        canonicalNamespace: 'default',
        canonicalPaths: paths('default'),
        discover,
        status: statusCheck,
        ensureLegacy: async () => state,
        async ensureCanonical({ installService }) {
          await installService();
          return state;
        },
        converge,
      }),
    ).rejects.toMatchObject({ code: 'LEGACY_ROUTES_ACTIVE' });
    expect(discoveryCount).toBe(2);
    expect(converge).not.toHaveBeenCalled();
  });

  it('reuses a compatible canonical service that becomes active under the installation lock', async () => {
    const canonical = installation('default');
    const legacy = installation('racing');
    const discover = vi
      .fn()
      .mockResolvedValueOnce(inventory(legacy))
      .mockResolvedValueOnce({ canonical, legacy: [legacy], invalid: [] });
    const statusCheck = vi.fn(async (selected) =>
      selected === canonical
        ? status(1)
        : {
            running: false,
            activeRoutes: 0,
            protocolVersion: null,
            compatible: false,
            state: null,
          },
    );
    const converge = vi.fn(async () => undefined);

    const result = await ensureStartupServiceLifecycle({
      canonicalNamespace: 'default',
      canonicalPaths: paths('default'),
      discover,
      status: statusCheck,
      ensureLegacy: async () => state,
      async ensureCanonical({ installService }) {
        await installService();
        return state;
      },
      converge,
    });

    expect(result).toMatchObject({ namespace: 'default', adoptedLegacy: false });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(converge).not.toHaveBeenCalled();
  });

  it('propagates a late-route refusal from the platform convergence transaction', async () => {
    const legacy = installation('late-route');
    const converge = vi.fn(async () => {
      throw Object.assign(new Error('A route became active.'), { code: 'ROUTES_ACTIVE' });
    });

    await expect(
      ensureStartupServiceLifecycle({
        canonicalNamespace: 'default',
        canonicalPaths: paths('default'),
        discover: async () => inventory(legacy),
        status: async () => status(0),
        ensureLegacy: async () => state,
        async ensureCanonical({ installService }) {
          await installService();
          return state;
        },
        converge,
      }),
    ).rejects.toMatchObject({ code: 'ROUTES_ACTIVE' });
    expect(converge).toHaveBeenCalledWith([legacy], undefined);
  });

  it('refuses persistent convergence while an installation target is unverified', async () => {
    const legacy = installation('verified');
    const invalid = {
      namespace: 'unsafe',
      recordPath: '/state/unsafe/service-install.json',
      reason: 'unrelated-definition' as const,
      message: 'The recorded definition was modified.',
    };
    const converge = vi.fn(async () => undefined);

    await expect(
      ensureStartupServiceLifecycle({
        canonicalNamespace: 'default',
        canonicalPaths: paths('default'),
        discover: async () => ({ canonical: null, legacy: [legacy], invalid: [invalid] }),
        status: async () => status(0),
        ensureLegacy: async () => state,
        async ensureCanonical({ installService }) {
          await installService();
          return state;
        },
        converge,
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_STARTUP_SERVICE_INSTALLATIONS' });
    expect(converge).not.toHaveBeenCalled();
  });

  it('refuses an incompatible active legacy service instead of disrupting it', async () => {
    const legacy = installation('old');

    await expect(
      ensureStartupServiceLifecycle({
        canonicalNamespace: 'default',
        canonicalPaths: paths('default'),
        discover: async () => inventory(legacy),
        status: async () => status(1, false),
        ensureLegacy: async () => state,
        ensureCanonical: async () => state,
        converge: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'INCOMPATIBLE_LEGACY_ROUTES' });
  });
});
