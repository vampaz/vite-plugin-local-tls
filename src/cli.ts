#!/usr/bin/env node

export function runCli(): void {}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
