export interface CommandExecutionOptions {
  interactive?: boolean;
  timeoutMs?: number;
}

export interface CommandExecutionResult {
  stdout: string;
  stderr: string;
}
