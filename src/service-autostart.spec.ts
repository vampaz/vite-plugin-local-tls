import { describe, expect, it, vi } from 'vitest';
import type { ServiceState } from './interfaces/service-state.js';
import { LocalTlsService } from './service.js';

const state: ServiceState = {
  version: 1,
  pid: 123,
  namespace: 'test',
  socketPath: '/tmp/control.sock',
  startedAt: '2026-01-01T00:00:00.000Z',
  protocolVersion: 1,
  port: 443,
  caFingerprint: 'fingerprint',
};

function createService(): LocalTlsService {
  return new LocalTlsService({
    namespace: 'test',
    opensslPath: 'openssl',
    paths: {
      stateDirectory: '/tmp/vite-local-tls-test-state',
      runtimeDirectory: '/tmp/vite-local-tls-test-runtime',
      socketPath: state.socketPath,
      lockPath: '/tmp/vite-local-tls-test-runtime/startup.lock',
      stateFile: '/tmp/vite-local-tls-test-state/service.json',
      certificateDirectory: '/tmp/vite-local-tls-test-state/certificates',
      importedCertificateDirectory: '/tmp/vite-local-tls-test-state/imported',
      caKeyPath: '/tmp/vite-local-tls-test-state/ca-key.pem',
      caCertificatePath: '/tmp/vite-local-tls-test-state/ca.pem',
      caStatePath: '/tmp/vite-local-tls-test-state/ca.json',
    },
  });
}

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('local TLS service auto-start', () => {
  it('starts directly when trust and port 443 are already available', async () => {
    const service = createService();
    vi.spyOn(service, 'ensureRunning').mockResolvedValue(state);
    const trust = vi.fn(async () => undefined);
    const installService = vi.fn(async () => undefined);

    await expect(
      service.autoStart({
        interactive: true,
        isTrusted: async () => true,
        trust,
        installService,
      }),
    ).resolves.toBe(state);
    expect(trust).not.toHaveBeenCalled();
    expect(installService).not.toHaveBeenCalled();
  });

  it('updates a stale installed service before registering a route', async () => {
    const service = createService();
    const start = vi.spyOn(service, 'ensureRunning');
    vi.spyOn(service, 'status').mockResolvedValue({
      running: true,
      activeRoutes: 0,
      protocolVersion: 1,
      compatible: true,
      state,
    });
    const installService = vi.fn(async () => undefined);

    await expect(
      service.autoStart({
        interactive: true,
        isTrusted: async () => true,
        trust: async () => undefined,
        isServiceCurrent: async () => false,
        installService,
      }),
    ).resolves.toBe(state);
    expect(installService).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });

  it('refuses to replace a stale service while another route is active', async () => {
    const service = createService();
    const start = vi.spyOn(service, 'ensureRunning');
    vi.spyOn(service, 'status').mockResolvedValue({
      running: true,
      activeRoutes: 1,
      protocolVersion: 1,
      compatible: true,
      state,
    });
    const installService = vi.fn(async () => undefined);

    await expect(
      service.autoStart({
        interactive: true,
        isTrusted: async () => true,
        trust: async () => undefined,
        isServiceCurrent: async () => false,
        installService,
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UPDATE_ROUTES_ACTIVE' });
    expect(installService).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('requires an explicit service update outside an interactive terminal', async () => {
    const service = createService();
    const start = vi.spyOn(service, 'ensureRunning');
    const installService = vi.fn(async () => undefined);

    await expect(
      service.autoStart({
        interactive: false,
        isTrusted: async () => true,
        trust: async () => undefined,
        isServiceCurrent: async () => false,
        installService,
      }),
    ).rejects.toMatchObject({
      code: 'SERVICE_UPDATE_REQUIRED',
      message: expect.stringContaining('vite-local-tls service install'),
    });
    expect(installService).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('fails early with the exact trust command in non-interactive environments', async () => {
    const service = createService();
    const start = vi.spyOn(service, 'ensureRunning');

    await expect(
      service.autoStart({
        interactive: false,
        isTrusted: async () => false,
        trust: async () => undefined,
        installService: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: 'TRUST_REQUIRED',
      message: expect.stringContaining('vite-local-tls trust'),
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('performs trust once in an interactive terminal before direct startup', async () => {
    const service = createService();
    vi.spyOn(service, 'ensureRunning').mockResolvedValue(state);
    let trusted = false;
    const trust = vi.fn(async () => {
      trusted = true;
    });

    await expect(
      service.autoStart({
        interactive: true,
        isTrusted: async () => trusted,
        trust,
        installService: async () => undefined,
      }),
    ).resolves.toBe(state);
    expect(trust).toHaveBeenCalledOnce();
  });

  it('installs the service interactively only when direct low-port binding is denied', async () => {
    const service = createService();
    vi.spyOn(service, 'ensureRunning').mockRejectedValue(codedError('EACCES'));
    vi.spyOn(service, 'status').mockResolvedValue({
      running: true,
      activeRoutes: 0,
      protocolVersion: 1,
      compatible: true,
      state,
    });
    const installService = vi.fn(async () => undefined);

    await expect(
      service.autoStart({
        interactive: true,
        isTrusted: async () => true,
        trust: async () => undefined,
        installService,
      }),
    ).resolves.toBe(state);
    expect(installService).toHaveBeenCalledOnce();
  });

  it('fails with the exact service command when elevation is unavailable non-interactively', async () => {
    const service = createService();
    vi.spyOn(service, 'ensureRunning').mockRejectedValue(codedError('EPERM'));

    await expect(
      service.autoStart({
        interactive: false,
        isTrusted: async () => true,
        trust: async () => undefined,
        installService: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: 'SERVICE_INSTALL_REQUIRED',
      message: expect.stringContaining('vite-local-tls service install'),
    });
  });

  it('never attempts service authorization in CI, even when terminal streams are TTYs', async () => {
    const streams = [process.stdin, process.stdout, process.stderr];
    const descriptors = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
    vi.stubEnv('CI', '1');
    for (const stream of streams) {
      Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
    }
    try {
      const service = createService();
      vi.spyOn(service, 'ensureRunning').mockRejectedValue(codedError('EACCES'));
      const installService = vi.fn(async () => undefined);

      await expect(
        service.autoStart({
          isTrusted: async () => true,
          trust: async () => undefined,
          installService,
        }),
      ).rejects.toMatchObject({ code: 'SERVICE_INSTALL_REQUIRED' });
      expect(installService).not.toHaveBeenCalled();
    } finally {
      streams.forEach((stream, index) => {
        const descriptor = descriptors[index];
        if (descriptor) {
          Object.defineProperty(stream, 'isTTY', descriptor);
        } else {
          Reflect.deleteProperty(stream, 'isTTY');
        }
      });
      vi.unstubAllEnvs();
    }
  });

  it('does not treat an occupied port as an authorization prompt', async () => {
    const service = createService();
    const error = codedError('EADDRINUSE');
    vi.spyOn(service, 'ensureRunning').mockRejectedValue(error);
    const installService = vi.fn(async () => undefined);

    await expect(
      service.autoStart({
        interactive: true,
        isTrusted: async () => true,
        trust: async () => undefined,
        installService,
      }),
    ).rejects.toBe(error);
    expect(installService).not.toHaveBeenCalled();
  });

  it('bounds an interactive authorization flow that never resolves', async () => {
    const service = createService();

    await expect(
      service.autoStart({
        interactive: true,
        authorizationTimeoutMs: 10,
        isTrusted: async () => false,
        trust: () => new Promise(() => undefined),
        installService: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_TIMEOUT' });
  });
});
