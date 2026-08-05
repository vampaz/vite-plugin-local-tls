import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workflowDirectory = path.join(repositoryRoot, '.github', 'workflows');

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const workflowNames = new Set();
const entries = (await readdir(workflowDirectory)).filter((name) => /\.ya?ml$/.test(name));
requireValue(entries.length >= 2, 'Expected at least the Tests and E2E workflows.');

for (const entry of entries) {
  const source = await readFile(path.join(workflowDirectory, entry), 'utf8');
  requireValue(!source.includes('\t'), `${entry} contains a tab character.`);
  requireValue(!/\bnpx\b/.test(source), `${entry} invokes npx.`);
  requireValue(!/\bcaddy\b/i.test(source), `${entry} contains a Caddy dependency.`);
  const workflow = parse(source);
  requireValue(workflow && typeof workflow === 'object', `${entry} is not a workflow object.`);
  requireValue(typeof workflow.name === 'string', `${entry} has no workflow name.`);
  requireValue(!workflowNames.has(workflow.name), `Duplicate workflow name: ${workflow.name}.`);
  workflowNames.add(workflow.name);
  requireValue(workflow.on && typeof workflow.on === 'object', `${entry} has no trigger.`);
  requireValue(workflow.jobs && typeof workflow.jobs === 'object', `${entry} has no jobs.`);
  for (const match of source.matchAll(/uses:\s*([^\s]+)/g)) {
    requireValue(
      match[1].includes('@') || match[1].startsWith('./'),
      `${entry} has an unpinned action.`,
    );
  }
}

requireValue(workflowNames.has('Tests'), 'The Tests workflow is missing.');
requireValue(workflowNames.has('E2E'), 'The reusable E2E workflow is missing.');
console.log(`Verified ${entries.length} workflow files.`);
