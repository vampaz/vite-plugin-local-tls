import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from './cli.js';
import type { CliActions, CliIo } from './interfaces/cli-options.js';

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
