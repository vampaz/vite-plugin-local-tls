import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const packageName = '@vampaz/vite-plugin-local-tls';

function run(command, arguments_, cwd) {
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
      if (code === 0) {
        resolve(Buffer.concat(output).toString().trim());
        return;
      }
      reject(
        new Error(
          `${command} ${arguments_.join(' ')} failed:\n${Buffer.concat(errors).toString()}${Buffer.concat(output).toString()}`,
        ),
      );
    });
  });
}

async function listRuntimeSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRuntimeSources(entryPath)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(entryPath);
    }
  }
  return files;
}

function findBareImports(source) {
  const imports = [];
  const pattern = /(?:from\s+|import\s*\()(['"])([^'"]+)\1/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[2];
    if (specifier && !specifier.startsWith('.') && !specifier.startsWith('node:')) {
      imports.push(specifier);
    }
  }
  return imports;
}

async function verifySourceImports() {
  const violations = [];
  for (const sourcePath of await listRuntimeSources(path.join(repositoryRoot, 'src'))) {
    const source = await readFile(sourcePath, 'utf8');
    for (const specifier of findBareImports(source)) {
      if (specifier !== 'vite') {
        violations.push(`${path.relative(repositoryRoot, sourcePath)} imports ${specifier}`);
      }
    }
    if (/\b(?:caddy|mkcert|portless)\b/i.test(source)) {
      violations.push(`${path.relative(repositoryRoot, sourcePath)} invokes a replaced TLS tool`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`Runtime dependency violations:\n${violations.join('\n')}`);
  }
}

async function verifyPackedInstall() {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-tls-zero-deps-'));
  try {
    const packOutput = await run(
      'npm',
      ['pack', '--json', '--pack-destination', temporaryDirectory],
      repositoryRoot,
    );
    const packResult = JSON.parse(packOutput);
    const packed = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
    if (!packed?.filename) {
      throw new Error('npm pack did not return an artifact filename.');
    }
    await writeFile(
      path.join(temporaryDirectory, 'package.json'),
      `${JSON.stringify(
        {
          name: 'vite-tls-zero-deps-fixture',
          version: '0.0.0',
          private: true,
          dependencies: {
            [packageName]: `file:${path.join(temporaryDirectory, packed.filename)}`,
            vite: '8.2.0',
          },
        },
        null,
        2,
      )}\n`,
    );
    await run('npm', ['install', '--ignore-scripts'], temporaryDirectory);
    await run('npm', ['ls', '--omit=dev', '--json'], temporaryDirectory);
    const installedPackage = JSON.parse(
      await readFile(
        path.join(temporaryDirectory, 'node_modules', packageName, 'package.json'),
        'utf8',
      ),
    );
    if (Object.keys(installedPackage.dependencies ?? {}).length > 0) {
      throw new Error('The packed plugin installed runtime dependencies.');
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const packageContract = JSON.parse(
  await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
);
if (Object.keys(packageContract.dependencies ?? {}).length > 0) {
  throw new Error('package.json must not declare runtime dependencies.');
}
await verifySourceImports();
await verifyPackedInstall();
console.log('Verified zero runtime dependencies and no replaced TLS tool invocation.');
