import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

async function readWorkflow(
  name: string,
): Promise<{ source: string; workflow: Record<string, any> }> {
  const source = await readFile(`${repositoryRoot}/.github/workflows/${name}`, 'utf8');
  return { source, workflow: parse(source) as Record<string, any> };
}

function allRunCommands(workflow: Record<string, any>): string[] {
  return Object.values(workflow.jobs as Record<string, any>).flatMap((job) =>
    (job.steps ?? []).flatMap((step: Record<string, string>) => (step.run ? [step.run] : [])),
  );
}

describe('Tests workflow', () => {
  it('gates pull requests and master pushes with the same cancellable workflow', async () => {
    const { workflow } = await readWorkflow('tests.yml');

    expect(workflow.name).toBe('Tests');
    expect(workflow.on.push.branches).toEqual(['master']);
    expect(workflow.on.pull_request.branches).toEqual(['master']);
    expect(workflow.concurrency).toEqual({
      group: '${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': true,
    });
    expect(workflow.jobs.e2e.uses).toBe('./.github/workflows/e2e.yml');
  });

  it('runs install, checks, tests, and build on Node 24', async () => {
    const { source, workflow } = await readWorkflow('tests.yml');
    const commands = allRunCommands(workflow);

    expect(source).toContain('actions/checkout@v4');
    expect(source).toContain('actions/setup-node@v4');
    expect(source).toContain('node-version: 24');
    expect(source).toContain('cache-dependency-path: package-lock.json');
    expect(commands).toEqual(['npm ci', 'npm run check', 'npm run test', 'npm run build']);
  });
});

describe('reusable E2E workflow', () => {
  it('prepares a disposable caddyless Node 24 runner and runs the full matrix', async () => {
    const { source, workflow } = await readWorkflow('e2e.yml');
    const commands = allRunCommands(workflow).join('\n');

    expect(workflow.name).toBe('E2E');
    expect(workflow.on).toHaveProperty('workflow_call');
    expect(source).toContain('actions/cache@v4');
    expect(source).toContain('node-version: 24');
    expect(commands).toContain('openssl');
    expect(commands).toContain('libnss3-tools');
    expect(commands).toContain('setcap cap_net_bind_service');
    expect(commands).toContain('VITE_LOCAL_TLS_E2E_PARENT=$RUNNER_TEMP/vite-local-tls-e2e');
    expect(commands).toContain('npm run playwright:install -- --with-deps');
    expect(commands).toContain('npm run test:e2e');
    expect(commands).toContain('npm run test:e2e:matrix');
    expect(source).not.toMatch(/\bnpx\b/);
    expect(source).not.toMatch(/\bcaddy\b/i);
  });
});
