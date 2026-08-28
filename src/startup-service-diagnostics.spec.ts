import { describe, expect, it } from 'vitest';
import type {
  DiscoveredStartupServiceInstallation,
  StartupServiceInstallationInventory,
} from './interfaces/service-installation-inventory.js';
import type { ServiceStatus } from './interfaces/service-status.js';
import { diagnoseStartupServices } from './startup-service-diagnostics.js';

function installation(namespace: string): DiscoveredStartupServiceInstallation {
  return {
    recordPath: `/state/${namespace}/service-install.json`,
    paths: {
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
    },
    record: {
      version: 1,
      platform: 'linux',
      namespace,
      identifier: `vite-local-tls-${namespace}`,
      definitionPath: `/etc/systemd/system/vite-local-tls-${namespace}.service`,
      nodePath: '/runtime/node',
      cliPath: '/runtime/cli.js',
      runtimeDirectory: '/runtime',
      controlSocket: null,
      installedAt: '2026-08-28T00:00:00.000Z',
    },
    options: {
      namespace,
      paths: {} as DiscoveredStartupServiceInstallation['paths'],
      nodePath: '/current/node',
      cliPath: '/current/cli.js',
    },
  };
}

function status(running: boolean, activeRoutes: number): ServiceStatus {
  return {
    running,
    activeRoutes,
    protocolVersion: running ? 1 : null,
    compatible: running,
    state: null,
  };
}

describe('startup service diagnostics', () => {
  it('reports an absent startup service without claiming that one is configured', async () => {
    const result = await diagnoseStartupServices(
      { canonical: null, legacy: [], invalid: [] },
      async () => status(false, 0),
      'absent',
    );

    expect(result).toMatchObject({
      repairRequired: false,
      repairCommand: null,
      installations: [],
      message: expect.stringContaining('No persistent startup service is installed'),
    });
  });

  it('identifies the active legacy winner and gives a non-destructive repair sequence', async () => {
    const canonical = installation('default');
    const legacy = installation('playground');
    const inventory: StartupServiceInstallationInventory = {
      canonical,
      legacy: [legacy],
      invalid: [],
    };

    const result = await diagnoseStartupServices(
      inventory,
      async (candidate) => (candidate === legacy ? status(true, 2) : status(false, 0)),
      'legacy',
    );

    expect(result).toMatchObject({
      activeLegacyNamespace: 'playground',
      repairRequired: true,
      repairCommand: null,
      message: expect.stringContaining('Stop the 2 active legacy route(s)'),
    });
  });

  it('blocks automated repair while any installation target is invalid', async () => {
    const legacy = installation('playground');
    const inventory: StartupServiceInstallationInventory = {
      canonical: null,
      legacy: [legacy],
      invalid: [
        {
          namespace: 'broken',
          recordPath: '/state/broken/service-install.json',
          reason: 'unrelated-definition',
          message: 'Ownership marker missing.',
        },
      ],
    };

    const result = await diagnoseStartupServices(inventory, async () => status(false, 0), 'absent');

    expect(result.repairRequired).toBe(true);
    expect(result.repairCommand).toBeNull();
    expect(result.invalidInstallations).toHaveLength(1);
    expect(result.message).toContain('manual inspection');
  });

  it('does not suggest a repair command that an older client must refuse', async () => {
    const legacy = installation('future');
    legacy.record = {
      ...legacy.record,
      version: 2,
      packageVersion: '99.0.0',
      protocolVersion: 2,
      installationState: 'installed',
    };

    const result = await diagnoseStartupServices(
      { canonical: null, legacy: [legacy], invalid: [] },
      async () => status(false, 0),
      'absent',
    );

    expect(result).toMatchObject({
      repairRequired: true,
      repairCommand: null,
      message: expect.stringContaining('requires a newer control protocol'),
    });
  });

  it('reports a legacy canonical service as repairable only after its routes are idle', async () => {
    const canonical = installation('default');
    const inventory: StartupServiceInstallationInventory = {
      canonical,
      legacy: [],
      invalid: [],
    };

    const active = await diagnoseStartupServices(inventory, async () => status(true, 1), 'legacy');
    const idle = await diagnoseStartupServices(inventory, async () => status(false, 0), 'legacy');

    expect(active).toMatchObject({
      canonicalUpdateStatus: 'legacy',
      repairRequired: true,
      repairCommand: null,
      message: expect.stringContaining('Stop the 1 active canonical route(s)'),
    });
    expect(idle.repairCommand).toBe('npm exec -- vite-local-tls service install');
  });

  it('does not suggest mutation when a repair target cannot be probed safely', async () => {
    const canonical = installation('default');
    const inventory: StartupServiceInstallationInventory = {
      canonical,
      legacy: [],
      invalid: [],
    };

    const result = await diagnoseStartupServices(
      inventory,
      async () => {
        throw new Error('Control channel could not be verified.');
      },
      'legacy',
    );

    expect(result).toMatchObject({
      repairRequired: true,
      repairCommand: null,
      installations: [
        expect.objectContaining({
          status: null,
          statusError: 'Control channel could not be verified.',
        }),
      ],
    });
  });
});
