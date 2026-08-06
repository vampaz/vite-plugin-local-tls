import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const expectedPackageName = '@vampaz/vite-plugin-local-tls';
const repositoryName = 'vampaz/vite-plugin-local-tls';
const repositoryUrl = `https://github.com/${repositoryName}.git`;

function run(command, arguments_, cwd = process.cwd()) {
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

function parsePackageSpecifier(specifier) {
  const separator = specifier.lastIndexOf('@');
  if (separator <= 0 || separator === specifier.length - 1) {
    throw new Error(`Expected a versioned package specifier, received ${specifier}.`);
  }
  return { name: specifier.slice(0, separator), version: specifier.slice(separator + 1) };
}

function parseJsonOutput(output) {
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed.at(-1) : parsed;
}

function resolveTagCommit(output, tag) {
  const references = new Map(
    output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, reference] = line.split(/\s+/);
        return [reference, sha];
      }),
  );
  return references.get(`refs/tags/${tag}^{}`) ?? references.get(`refs/tags/${tag}`);
}

async function verifyConsumerInstall(specifier, packageName, version) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vite-tls-published-'));
  try {
    await writeFile(
      path.join(temporaryDirectory, 'package.json'),
      `${JSON.stringify(
        {
          name: 'vite-local-tls-published-fixture',
          version: '0.0.0',
          private: true,
          type: 'module',
          dependencies: {
            '@types/node': '26.1.2',
            [packageName]: version,
            vite: '8.2.0',
          },
        },
        null,
        2,
      )}\n`,
    );
    await run(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
      temporaryDirectory,
    );
    const installedManifest = JSON.parse(
      await readFile(
        path.join(temporaryDirectory, 'node_modules', packageName, 'package.json'),
        'utf8',
      ),
    );
    requireValue(installedManifest.version === version, 'Consumer installed the wrong version.');
    await run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const value = await import('${packageName}');
if (typeof value.default !== 'function' || typeof value.resolveLocalTlsDomains !== 'function') process.exit(1);`,
      ],
      temporaryDirectory,
    );
    const cliPath = path.join(
      temporaryDirectory,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'vite-local-tls.cmd' : 'vite-local-tls',
    );
    const cli = await run(cliPath, ['--help'], temporaryDirectory);
    requireValue(cli.stdout.includes('Usage: vite-local-tls'), 'Published CLI did not run.');
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const specifier = process.argv[2];
if (!specifier) {
  throw new Error('Usage: npm run verify:published -- @vampaz/vite-plugin-local-tls@<version>');
}
const { name: packageName, version } = parsePackageSpecifier(specifier);
requireValue(packageName === expectedPackageName, `Unexpected package name: ${packageName}.`);

const metadata = parseJsonOutput((await run('npm', ['view', specifier, '--json'])).stdout);
requireValue(metadata.name === packageName, 'Registry metadata has the wrong package name.');
requireValue(metadata.version === version, 'Registry metadata has the wrong version.');
requireValue(typeof metadata.gitHead === 'string', 'Registry metadata has no gitHead.');
const gitHead = metadata.gitHead;

const distTags = parseJsonOutput(
  (await run('npm', ['view', packageName, 'dist-tags', '--json'])).stdout,
);
requireValue(
  distTags.latest === version,
  `npm latest points to ${distTags.latest}, not ${version}.`,
);

const attestationUrl = metadata.dist?.attestations?.url;
requireValue(typeof attestationUrl === 'string', 'Registry metadata has no attestations URL.');
const attestationResponse = await fetch(attestationUrl);
requireValue(
  attestationResponse.ok,
  `Attestation request failed with ${attestationResponse.status}.`,
);
const attestationDocument = await attestationResponse.json();
const provenance = attestationDocument.attestations?.find(
  ({ predicateType }) => predicateType === 'https://slsa.dev/provenance/v1',
);
requireValue(provenance?.bundle?.dsseEnvelope?.payload, 'SLSA provenance attestation is missing.');
const statement = JSON.parse(
  Buffer.from(provenance.bundle.dsseEnvelope.payload, 'base64').toString(),
);
const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
requireValue(
  workflow?.repository === `https://github.com/${repositoryName}`,
  'Provenance repository is incorrect.',
);
requireValue(
  workflow?.path === '.github/workflows/release.yml',
  'Provenance workflow is incorrect.',
);
const commits =
  statement.predicate?.buildDefinition?.resolvedDependencies?.flatMap(({ digest }) =>
    digest?.gitCommit ? [digest.gitCommit] : [],
  ) ?? [];
requireValue(commits.includes(gitHead), 'Provenance does not resolve to npm gitHead.');

const tagCandidates = [`v${version}`, `${packageName}@${version}`];
const remoteTags = await run('git', [
  'ls-remote',
  '--tags',
  repositoryUrl,
  ...tagCandidates.flatMap((tag) => [`refs/tags/${tag}`, `refs/tags/${tag}^{}`]),
]);
const tag = tagCandidates.find(
  (candidate) => resolveTagCommit(remoteTags.stdout, candidate) === gitHead,
);
requireValue(tag, 'No supported Git tag matches npm gitHead.');

const release = parseJsonOutput(
  (
    await run('gh', [
      'release',
      'view',
      tag,
      '--repo',
      repositoryName,
      '--json',
      'tagName,isDraft,isPrerelease,url',
    ])
  ).stdout,
);
requireValue(release.tagName === tag, 'GitHub Release has the wrong tag.');
requireValue(release.isDraft === false, 'GitHub Release is still a draft.');
requireValue(release.isPrerelease === false, 'GitHub Release is unexpectedly a prerelease.');

await verifyConsumerInstall(specifier, packageName, version);
console.log(
  JSON.stringify(
    {
      package: specifier,
      latest: distTags.latest,
      gitHead,
      tag,
      release: release.url,
      provenance: attestationUrl,
      consumerInstall: 'passed',
    },
    null,
    2,
  ),
);
