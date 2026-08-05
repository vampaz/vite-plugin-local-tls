import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const packageName = '@vampaz/vite-plugin-local-tls';

function run(command, arguments_, cwd = repositoryRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = [];
    const errors = [];
    child.stdout.on('data', (chunk) => output.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('exit', (code) => {
      const stdout = Buffer.concat(output).toString();
      const stderr = Buffer.concat(errors).toString();
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${arguments_.join(' ')} failed:\n${stderr}${stdout}`));
    });
  });
}

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isAllowedFile(filePath) {
  if (
    [
      'CHANGELOG.md',
      'CONTRIBUTING.md',
      'LICENSE',
      'MIGRATION.md',
      'README.md',
      'RELEASING.md',
      'SECURITY.md',
      'package.json',
    ].includes(filePath)
  ) {
    return true;
  }
  return /^dist\/.+\.(?:d\.ts|d\.ts\.map|js|js\.map)$/.test(filePath);
}

await run('npm', ['run', 'verify:zero-deps']);
await run('npm', ['run', 'verify:package']);

const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
requireValue(manifest.name === packageName, 'Unexpected release package name.');
requireValue(Object.keys(manifest.dependencies ?? {}).length === 0, 'Runtime dependencies found.');
requireValue(manifest.publishConfig?.access === 'public', 'Package access is not public.');
requireValue(
  manifest.peerDependencies?.vite === '^3.0.0 || ^4.0.0 || ^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0',
  'Unexpected Vite peer range.',
);

const packResult = await run('npm', ['pack', '--dry-run', '--json']);
const parsed = JSON.parse(packResult.stdout);
const record = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
requireValue(record?.name === packageName, 'Dry-run artifact has the wrong package name.');
requireValue(record?.version === manifest.version, 'Dry-run artifact has the wrong version.');
const unexpected = (record.files ?? [])
  .map(({ path: filePath }) => filePath)
  .filter((filePath) => !isAllowedFile(filePath));
requireValue(
  unexpected.length === 0,
  `Dry-run artifact contains unexpected files:\n${unexpected.join('\n')}`,
);

console.log(
  `Release dry run passed for ${packageName}@${manifest.version} with ${record.files.length} files. No publication attempted.`,
);
