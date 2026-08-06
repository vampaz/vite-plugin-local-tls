import { execFile, spawn } from 'node:child_process';
import type {
  CommandExecutionOptions,
  CommandExecutionResult,
} from './interfaces/command-execution-options.js';

const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

function commandError(command: string, arguments_: string[], detail: string, cause?: Error): Error {
  return new Error(`Command failed: ${command} ${arguments_.join(' ')}\n${detail}`, { cause });
}

function hasInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY);
}

function runCapturedCommand(
  command: string,
  arguments_: string[],
  options: CommandExecutionOptions,
): Promise<CommandExecutionResult> {
  return new Promise(function runCapturedCommandPromise(resolve, reject) {
    execFile(
      command,
      arguments_,
      { maxBuffer: MAX_BUFFER_SIZE, timeout: options.timeoutMs },
      function handleCommand(error, stdout, stderr) {
        if (error) {
          reject(commandError(command, arguments_, stderr.trim() || error.message, error));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function runInteractiveCommand(
  command: string,
  arguments_: string[],
  options: CommandExecutionOptions,
): Promise<CommandExecutionResult> {
  if (process.env.CI && command === 'sudo') {
    return runCapturedCommand(command, ['-n', ...arguments_], options);
  }
  if (!hasInteractiveTerminal()) {
    return Promise.reject(
      new Error(
        'Administrator authorization requires an interactive terminal. Re-run the vite-local-tls command in a terminal with TTY access.',
      ),
    );
  }
  return new Promise(function runInteractiveCommandPromise(resolve, reject) {
    const child = spawn(command, arguments_, {
      stdio: 'inherit',
      timeout: options.timeoutMs,
    });
    child.once('error', function handleCommandError(error) {
      reject(commandError(command, arguments_, error.message, error));
    });
    child.once('close', function handleCommandClose(code, signal) {
      if (code === 0) {
        resolve({ stdout: '', stderr: '' });
        return;
      }
      const detail = signal
        ? `Command terminated by signal ${signal}.`
        : `Command exited with code ${code ?? 'unknown'}.`;
      reject(commandError(command, arguments_, detail));
    });
  });
}

export function executeCommand(
  command: string,
  arguments_: string[],
  options: CommandExecutionOptions = {},
): Promise<CommandExecutionResult> {
  return options.interactive
    ? runInteractiveCommand(command, arguments_, options)
    : runCapturedCommand(command, arguments_, options);
}
