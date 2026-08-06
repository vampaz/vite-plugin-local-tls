import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeCommand } from './command-runner.js';

const childProcessMocks = vi.hoisted(function createChildProcessMocks() {
  return {
    execFile: vi.fn(),
    spawn: vi.fn(),
  };
});

vi.mock('node:child_process', function mockChildProcess() {
  return childProcessMocks;
});

const streams = [process.stdin, process.stdout, process.stderr];
let ttyDescriptors: Array<PropertyDescriptor | undefined>;

function setTerminalAvailability(available: boolean): void {
  for (const stream of streams) {
    Object.defineProperty(stream, 'isTTY', { configurable: true, value: available });
  }
}

beforeEach(function prepareCommandRunnerTest() {
  ttyDescriptors = streams.map(function readDescriptor(stream) {
    return Object.getOwnPropertyDescriptor(stream, 'isTTY');
  });
  vi.stubEnv('CI', '');
  childProcessMocks.execFile.mockReset();
  childProcessMocks.spawn.mockReset();
});

afterEach(function restoreCommandRunnerTest() {
  streams.forEach(function restoreDescriptor(stream, index) {
    const descriptor = ttyDescriptors[index];
    if (descriptor) {
      Object.defineProperty(stream, 'isTTY', descriptor);
      return;
    }
    Reflect.deleteProperty(stream, 'isTTY');
  });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('command runner', function describeCommandRunner() {
  it('keeps ordinary command output captured', async function testCapturedCommand() {
    childProcessMocks.execFile.mockImplementation(function runMockCommand(
      _command: string,
      _arguments: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) {
      callback(null, 'captured output', '');
    });

    await expect(executeCommand('git', ['status'])).resolves.toEqual({
      stdout: 'captured output',
      stderr: '',
    });
    expect(childProcessMocks.execFile).toHaveBeenCalledOnce();
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it('inherits terminal streams directly on macOS', async function testMacosCommand() {
    setTerminalAvailability(true);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const child = new EventEmitter();
    childProcessMocks.spawn.mockReturnValue(child);

    const result = executeCommand('sudo', ['--', 'true'], {
      interactive: true,
      timeoutMs: 30_000,
    });
    child.emit('close', 0, null);

    await expect(result).resolves.toEqual({ stdout: '', stderr: '' });
    expect(childProcessMocks.spawn).toHaveBeenCalledWith('sudo', ['--', 'true'], {
      stdio: 'inherit',
      timeout: 30_000,
    });
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('inherits terminal streams directly on Linux', async function testLinuxCommand() {
    setTerminalAvailability(true);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const child = new EventEmitter();
    childProcessMocks.spawn.mockReturnValue(child);

    const result = executeCommand('sudo', ['--', 'true'], { interactive: true });
    child.emit('close', 0, null);

    await expect(result).resolves.toEqual({ stdout: '', stderr: '' });
    expect(childProcessMocks.spawn).toHaveBeenCalledWith('sudo', ['--', 'true'], {
      stdio: 'inherit',
      timeout: undefined,
    });
  });

  it('uses non-prompting sudo in CI', async function testCiCommand() {
    setTerminalAvailability(false);
    vi.stubEnv('CI', '1');
    childProcessMocks.execFile.mockImplementation(function runMockCommand(
      _command: string,
      _arguments: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) {
      callback(null, '', '');
    });

    await expect(executeCommand('sudo', ['--', 'true'], { interactive: true })).resolves.toEqual({
      stdout: '',
      stderr: '',
    });
    expect(childProcessMocks.execFile).toHaveBeenCalledWith(
      'sudo',
      ['-n', '--', 'true'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it('fails before spawning when no interactive terminal is available', async function testNoTty() {
    setTerminalAvailability(false);

    await expect(executeCommand('sudo', ['--', 'true'], { interactive: true })).rejects.toThrow(
      /interactive terminal/,
    );
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });
});
