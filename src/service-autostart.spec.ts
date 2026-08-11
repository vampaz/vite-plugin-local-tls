import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandExecutionOptions } from './interfaces/command-execution-options.js';
import type { ServiceState } from './interfaces/service-state.js';
import type { StatePaths } from './interfaces/state-paths.js';
import { installStartupService } from './service-install.js';
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

const temporaryDirectories = new Set<string>();
let serviceSequence = 0;

function createStatePaths(directory: string): StatePaths {
  return {
    stateDirectory: path.join(directory, 'state'),
    runtimeDirectory: path.join(directory, 'runtime'),
    socketPath: path.join(directory, 'runtime', 'control.sock'),
    lockPath: path.join(directory, 'runtime', 'startup.lock'),
    stateFile: path.join(directory, 'state', 'service.json'),
    certificateDirectory: path.join(directory, 'state', 'certificates'),
    importedCertificateDirectory: path.join(directory, 'state', 'imported'),
    caKeyPath: path.join(directory, 'state', 'ca-key.pem'),
    caCertificatePath: path.join(directory, 'state', 'ca.pem'),
    caStatePath: path.join(directory, 'state', 'ca.json'),
  };
}

function createService(temporaryDirectory?: string): LocalTlsService {
  const directory =
    temporaryDirectory ??
    path.join(os.tmpdir(), `vite-local-tls-autostart-${process.pid}-${serviceSequence++}`);
  temporaryDirectories.add(directory);
  return new LocalTlsService({
    namespace: 'test',
    opensslPath: 'openssl',
    paths: createStatePaths(directory),
  });
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('local TLS service auto-start', () => {
  it.each([true, false])(
    'uses a healthy service without invoking the installer (interactive=%s)',
    async (interactive) => {
      const service = createService();
      vi.spyOn(service, 'ensureRunning').mockResolvedValue(state);
      const trust = vi.fn(async () => undefined);
      const installService = vi.fn(async () => undefined);

      await expect(
        service.autoStart({
          interactive,
          isTrusted: async () => true,
          trust,
          installService,
        }),
      ).resolves.toBe(state);
      expect(trust).not.toHaveBeenCalled();
      expect(installService).not.toHaveBeenCalled();
    },
  );

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
      message: expect.stringContaining('npm exec -- vite-local-tls trust'),
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
      message: expect.stringContaining('npm exec -- vite-local-tls service install'),
    });
  });

  it('routes background macOS startup through native graphical authorization', async () => {
    const streams = [process.stdin, process.stdout, process.stderr];
    const descriptors = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.stubEnv('CI', '');
    for (const stream of streams) {
      Object.defineProperty(stream, 'isTTY', { configurable: true, value: false });
    }
    try {
      const directory = path.join(
        os.tmpdir(),
        `vite-local-tls-autostart-macos-background-${process.pid}`,
      );
      const paths = createStatePaths(directory);
      const cliPath = path.join(directory, 'project', 'dist', 'cli.js');
      await mkdir(path.dirname(cliPath), { recursive: true });
      await writeFile(cliPath, 'export {};\n');
      const service = createService(directory);
      vi.spyOn(service, 'ensureRunning').mockRejectedValue(codedError('EACCES'));
      vi.spyOn(service, 'status').mockResolvedValue({
        running: true,
        activeRoutes: 0,
        protocolVersion: 1,
        compatible: true,
        state,
      });
      const runner = vi.fn(
        async (_command: string, _arguments: string[], _options?: CommandExecutionOptions) => ({
          stdout: '',
          stderr: '',
        }),
      );
      const installService = vi.fn(async () => {
        await installStartupService({
          platform: 'darwin',
          namespace: 'test',
          paths,
          nodePath: '/opt/homebrew/bin/node',
          cliPath,
          homeDirectory: directory,
          uid: 501,
          username: 'developer',
          definitionDirectory: path.join(directory, 'Library', 'LaunchDaemons'),
          runtimeInstallDirectory: path.join(directory, 'system-runtime'),
          runner,
        });
      });

      await expect(
        service.autoStart({
          isTrusted: async () => true,
          trust: async () => undefined,
          installService,
        }),
      ).resolves.toBe(state);
      expect(installService).toHaveBeenCalledOnce();
      expect(runner).toHaveBeenCalledOnce();
      expect(runner).toHaveBeenCalledWith('/usr/bin/osascript', expect.any(Array));
      expect(runner.mock.calls[0]?.[1]).toContain(
        'do shell script (commandPath & " --input-type=module --eval " & source & " " & requests) with administrator privileges with prompt "Vite Local TLS needs permission to install or update its local HTTPS service."',
      );
    } finally {
      platform.mockRestore();
      vi.unstubAllEnvs();
      streams.forEach((stream, index) => {
        const descriptor = descriptors[index];
        if (descriptor) {
          Object.defineProperty(stream, 'isTTY', descriptor);
        } else {
          Reflect.deleteProperty(stream, 'isTTY');
        }
      });
    }
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

  it('waits for interactive service authorization for longer than 30 seconds', async () => {
    const service = createService();
    vi.spyOn(service, 'ensureRunning').mockRejectedValue(codedError('EACCES'));
    vi.spyOn(service, 'status').mockResolvedValue({
      running: true,
      activeRoutes: 0,
      protocolVersion: 1,
      compatible: true,
      state,
    });
    let finishInstall: (() => void) | undefined;
    const installService = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishInstall = resolve;
        }),
    );

    try {
      const result = service.autoStart({
        interactive: true,
        isTrusted: async () => true,
        trust: async () => undefined,
        installService,
      });
      await vi.waitFor(() => expect(installService).toHaveBeenCalledOnce());
      vi.useFakeTimers();
      const settled = vi.fn();
      void result.then(settled, settled);

      await vi.advanceTimersByTimeAsync(30_001);

      expect(settled).not.toHaveBeenCalled();
      finishInstall?.();
      await expect(result).resolves.toBe(state);
      expect(installService).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes trust authorization across simultaneous service starts', async () => {
    const temporaryDirectory = path.join(
      os.tmpdir(),
      `vite-local-tls-autostart-shared-trust-${process.pid}`,
    );
    const firstService = createService(temporaryDirectory);
    const secondService = createService(temporaryDirectory);
    vi.spyOn(firstService, 'ensureRunning').mockResolvedValue(state);
    vi.spyOn(secondService, 'ensureRunning').mockResolvedValue(state);
    let trusted = false;
    let finishTrust: (() => void) | undefined;
    const trust = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishTrust = function resolveTrust() {
            trusted = true;
            resolve();
          };
        }),
    );
    const onAuthorizationWait = vi.fn();
    const options = {
      interactive: true,
      onAuthorizationWait,
      isTrusted: async () => trusted,
      trust,
      installService: async () => undefined,
    };

    const firstStart = firstService.autoStart(options);
    await vi.waitFor(() => expect(trust).toHaveBeenCalledOnce());
    const secondStart = secondService.autoStart(options);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(trust).toHaveBeenCalledOnce();
    finishTrust?.();
    await expect(Promise.all([firstStart, secondStart])).resolves.toEqual([state, state]);
    expect(trust).toHaveBeenCalledOnce();
    expect(onAuthorizationWait).toHaveBeenCalledOnce();
  });

  it('serializes service authorization across simultaneous service starts', async () => {
    const temporaryDirectory = path.join(
      os.tmpdir(),
      `vite-local-tls-autostart-shared-service-${process.pid}`,
    );
    const firstService = createService(temporaryDirectory);
    const secondService = createService(temporaryDirectory);
    let installed = false;
    for (const service of [firstService, secondService]) {
      vi.spyOn(service, 'ensureRunning').mockImplementation(async () => {
        if (!installed) {
          throw codedError('EACCES');
        }
        return state;
      });
      vi.spyOn(service, 'status').mockResolvedValue({
        running: true,
        activeRoutes: 0,
        protocolVersion: 1,
        compatible: true,
        state,
      });
    }
    let finishInstall: (() => void) | undefined;
    const installService = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishInstall = function resolveInstall() {
            installed = true;
            resolve();
          };
        }),
    );
    const onAuthorizationWait = vi.fn();
    const options = {
      interactive: true,
      onAuthorizationWait,
      isTrusted: async () => true,
      trust: async () => undefined,
      installService,
    };

    const firstStart = firstService.autoStart(options);
    await vi.waitFor(() => expect(installService).toHaveBeenCalledOnce());
    const secondStart = secondService.autoStart(options);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(installService).toHaveBeenCalledOnce();
    finishInstall?.();
    await expect(Promise.all([firstStart, secondStart])).resolves.toEqual([state, state]);
    expect(installService).toHaveBeenCalledOnce();
    expect(onAuthorizationWait).toHaveBeenCalledOnce();
  });
});
