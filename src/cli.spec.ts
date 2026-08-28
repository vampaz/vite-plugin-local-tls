import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from './cli.js';
import type { CliActions, CliIo } from './interfaces/cli-options.js';
import { LocalTlsService } from './service.js';

let stdout: string;
let stderr: string;
let io: CliIo;
let actions: CliActions;

function createActions(): CliActions {
  return {
    trust: vi.fn(async () => ({ command: 'trust' })),
    untrust: vi.fn(async () => ({ command: 'untrust' })),
    certificateImport: vi.fn(async () => ({ command: 'certificateImport' })),
    certificateList: vi.fn(async () => ({ command: 'certificateList' })),
    certificateRemove: vi.fn(async () => ({ command: 'certificateRemove' })),
    doctor: vi.fn(async () => ({ command: 'doctor' })),
    proxyStart: vi.fn(async () => ({ command: 'proxyStart' })),
    proxyStop: vi.fn(async () => ({ command: 'proxyStop' })),
    proxyStatus: vi.fn(async () => ({ command: 'proxyStatus' })),
    serviceInstall: vi.fn(async () => ({ command: 'serviceInstall' })),
    serviceUninstall: vi.fn(async () => ({ command: 'serviceUninstall' })),
    clean: vi.fn(async () => ({ command: 'clean' })),
  };
}

beforeEach(() => {
  stdout = '';
  stderr = '';
  io = {
    stdout(message): void {
      stdout += message;
    },
    stderr(message): void {
      stderr += message;
    },
  };
  actions = createActions();
});

describe('vite-local-tls CLI', () => {
  it.each([
    [['trust'], 'trust'],
    [['untrust'], 'untrust'],
    [['cert', 'list'], 'certificateList'],
    [['doctor'], 'doctor'],
    [['proxy', 'start'], 'proxyStart'],
    [['proxy', 'stop'], 'proxyStop'],
    [['proxy', 'status'], 'proxyStatus'],
    [['service', 'install'], 'serviceInstall'],
    [['service', 'uninstall'], 'serviceUninstall'],
  ] as const)('dispatches %j to the focused infrastructure action', async (arguments_, action) => {
    const exitCode = await runCli([...arguments_], { actions, io });

    expect(exitCode).toBe(0);
    expect(actions[action]).toHaveBeenCalledWith(
      action === 'proxyStart'
        ? { namespace: 'default', serviceMode: false }
        : { namespace: 'default' },
    );
    expect(stderr).toBe('');
  });

  it('parses exact-host certificate import and removal options', async () => {
    await expect(
      runCli(
        [
          'cert',
          'import',
          '--namespace',
          'team',
          '--hostname',
          'app.localhost',
          '--cert',
          '/tmp/cert.pem',
          '--key',
          '/tmp/key.pem',
          '--chain',
          '/tmp/chain.pem',
        ],
        { actions, io },
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(['cert', 'remove', '--hostname', 'app.localhost'], { actions, io }),
    ).resolves.toBe(0);

    expect(actions.certificateImport).toHaveBeenCalledWith({
      namespace: 'team',
      hostname: 'app.localhost',
      certificatePath: '/tmp/cert.pem',
      keyPath: '/tmp/key.pem',
      chainPath: '/tmp/chain.pem',
    });
    expect(actions.certificateRemove).toHaveBeenCalledWith({
      namespace: 'default',
      hostname: 'app.localhost',
    });
  });

  it('keeps CA deletion opt-in during cleanup', async () => {
    await runCli(['clean'], { actions, io });
    await runCli(['clean', '--ca'], { actions, io });

    expect(actions.clean).toHaveBeenNthCalledWith(1, {
      namespace: 'default',
      removeAuthority: false,
    });
    expect(actions.clean).toHaveBeenNthCalledWith(2, {
      namespace: 'default',
      removeAuthority: true,
    });
  });

  it('passes service supervision mode only to proxy start', async () => {
    await runCli(['proxy', 'start', '--service'], { actions, io });

    expect(actions.proxyStart).toHaveBeenCalledWith({
      namespace: 'default',
      serviceMode: true,
    });
  });

  it('refuses to create a second persistent port-443 service namespace', async () => {
    await expect(
      runCli(['service', 'install', '--namespace', 'project-a'], { actions, io }),
    ).resolves.toBe(1);

    expect(actions.serviceInstall).not.toHaveBeenCalled();
    expect(stderr).toContain('one machine-wide startup service');
    expect(stderr).toContain('omit `--namespace`');
  });

  it('refuses to move the canonical startup service to another control channel', async () => {
    await expect(
      runCli(['service', 'install', '--control-socket', '/tmp/alternate.sock'], { actions, io }),
    ).resolves.toBe(1);

    expect(actions.serviceInstall).not.toHaveBeenCalled();
    expect(stderr).toContain('one control channel');
    expect(stderr).toContain('omit `--control-socket`');
  });

  it('allows explicit removal of a legacy namespaced startup service', async () => {
    await expect(
      runCli(['service', 'uninstall', '--namespace', 'project-a'], { actions, io }),
    ).resolves.toBe(0);

    expect(actions.serviceUninstall).toHaveBeenCalledWith({ namespace: 'project-a' });
  });

  it.each([
    ['install', []],
    ['uninstall', ['--namespace', 'project-a']],
  ] as const)(
    'coordinates manual service %s through the canonical mutation lock',
    async (command, options) => {
      const mutation = vi
        .spyOn(LocalTlsService.prototype, 'withStartupServiceMutationLock')
        .mockResolvedValue({ coordinated: command });
      try {
        await expect(runCli(['service', command, ...options], { io })).resolves.toBe(0);

        expect(mutation).toHaveBeenCalledOnce();
        expect(stdout).toContain(`"coordinated": "${command}"`);
        expect(stderr).toBe('');
      } finally {
        mutation.mockRestore();
      }
    },
  );

  it('exits cleanly when a startup manager finds port 443 already occupied', async () => {
    vi.mocked(actions.proxyStart).mockRejectedValueOnce(
      Object.assign(new Error('Port 443 is already occupied.'), { code: 'EADDRINUSE' }),
    );

    await expect(runCli(['proxy', 'start', '--service'], { actions, io })).resolves.toBe(0);

    expect(stderr).toContain('Port 443 is already occupied.');
    expect(stderr).toContain('will remain stopped');
  });

  it('loads the installed service context from its validated runtime configuration', async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-local-tls-cli-'));
    const configurationPath = path.join(temporaryDirectory, 'service.json');
    try {
      await writeFile(
        configurationPath,
        `${JSON.stringify({
          version: 1,
          owner: '@vampaz/vite-plugin-local-tls',
          namespace: 'windows-service',
          controlSocket: '\\\\.\\pipe\\windows-service',
        })}\n`,
      );

      await runCli(['proxy', 'start', '--service', '--service-config', configurationPath], {
        actions,
        io,
      });

      expect(actions.proxyStart).toHaveBeenCalledWith({
        namespace: 'windows-service',
        controlSocket: '\\\\.\\pipe\\windows-service',
        serviceMode: true,
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('passes a complete service privilege-drop identity to proxy start', async () => {
    await runCli(['proxy', 'start', '--service', '--run-as-uid', '501', '--run-as-gid', '20'], {
      actions,
      io,
    });

    expect(actions.proxyStart).toHaveBeenCalledWith({
      namespace: 'default',
      serviceMode: true,
      runAsUid: 501,
      runAsGid: 20,
    });
  });

  it('passes an alternate control socket through infrastructure commands', async () => {
    await runCli(['proxy', 'status', '--control-socket', '/tmp/team.sock', '--namespace', 'team'], {
      actions,
      io,
    });

    expect(actions.proxyStatus).toHaveBeenCalledWith({
      namespace: 'team',
      controlSocket: '/tmp/team.sock',
    });
  });

  it('prints focused help without running an action', async () => {
    await expect(runCli(['--help'], { actions, io })).resolves.toBe(0);

    expect(stdout).toContain('cert import');
    expect(stdout).toContain('service install');
    expect(Object.values(actions).every((action) => !vi.mocked(action).mock.calls.length)).toBe(
      true,
    );
  });

  it('rejects missing values and unknown commands without invoking actions', async () => {
    await expect(
      runCli(['cert', 'import', '--hostname', 'app.localhost'], { actions, io }),
    ).resolves.toBe(1);
    await expect(runCli(['run', 'anything'], { actions, io })).resolves.toBe(1);

    expect(stderr).toContain('Missing required option --cert');
    expect(stderr).toContain('Unknown command: run anything');
  });
});
