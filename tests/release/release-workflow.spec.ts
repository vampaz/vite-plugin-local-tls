import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

type WorkflowEventFixture = {
  repository: string;
  remoteMasterSha: string;
  workflowRun: {
    conclusion: string;
    event: string;
    headBranch: string;
    headRepository: string;
    headSha: string;
  };
};

async function readReleaseWorkflow(): Promise<{
  source: string;
  workflow: Record<string, any>;
}> {
  const source = await readFile(`${repositoryRoot}/.github/workflows/release.yml`, 'utf8');
  return { source, workflow: parse(source) as Record<string, any> };
}

async function readEventFixtures(): Promise<Array<{ name: string; event: WorkflowEventFixture }>> {
  const directory = `${repositoryRoot}/tests/fixtures/workflow-events`;
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      event: JSON.parse(await readFile(`${directory}/${name}`, 'utf8')) as WorkflowEventFixture,
    })),
  );
}

function canPublish(fixture: WorkflowEventFixture): boolean {
  const run = fixture.workflowRun;
  return (
    run.conclusion === 'success' &&
    run.event === 'push' &&
    run.headBranch === 'master' &&
    run.headRepository === fixture.repository &&
    run.headSha === fixture.remoteMasterSha
  );
}

describe('Release workflow', () => {
  it('runs only from the completed Tests workflow on master', async () => {
    const { workflow } = await readReleaseWorkflow();

    expect(workflow.on.workflow_run).toEqual({
      workflows: ['Tests'],
      branches: ['master'],
      types: ['completed'],
    });
    expect(workflow.concurrency).toEqual({
      group: '${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': true,
    });
    expect(workflow.jobs.publish.if).toContain("conclusion == 'success'");
    expect(workflow.jobs.publish.if).toContain("event == 'push'");
    expect(workflow.jobs.publish.if).toContain("head_branch == 'master'");
    expect(workflow.jobs.publish.if).toContain('head_repository.full_name == github.repository');
  });

  it('checks out and revalidates the exact successful current-master SHA', async () => {
    const { source, workflow } = await readReleaseWorkflow();
    const steps = workflow.jobs.publish.steps as Array<Record<string, any>>;
    const checkout = steps.find((step) => step.uses === 'actions/checkout@v7');
    const freshness = steps.find((step) => step.name === 'Verify tested commit is current master');

    expect(checkout?.with.ref).toBe('${{ github.event.workflow_run.head_sha }}');
    expect(freshness?.env.TESTED_SHA).toBe('${{ github.event.workflow_run.head_sha }}');
    expect(freshness?.run).toContain('git fetch origin master --depth=1');
    expect(freshness?.run).toContain('test "$TESTED_SHA" = "$current_master_sha"');
    expect(source).not.toContain('npm publish');
  });

  it('uses Changesets with npm OIDC provenance and write-scoped permissions', async () => {
    const { workflow } = await readReleaseWorkflow();
    const steps = workflow.jobs.publish.steps as Array<Record<string, any>>;
    const changesets = steps.find((step) => step.uses === 'changesets/action@v1');

    expect(workflow.permissions).toEqual({
      contents: 'write',
      'pull-requests': 'write',
      'id-token': 'write',
    });
    expect(steps.some((step) => step.uses === 'actions/setup-node@v7')).toBe(true);
    expect(steps.some((step) => step.run === 'npm install --global npm@latest')).toBe(true);
    expect(steps.some((step) => step.run === 'npm ci')).toBe(true);
    expect(changesets?.with.publish).toBe('npm run changeset:publish');
    expect(changesets?.env.GITHUB_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(changesets?.env.NPM_CONFIG_PROVENANCE).toBe(true);
    expect(changesets?.env).not.toHaveProperty('NPM_TOKEN');
  });

  it('rejects failed, cancelled, pull-request-only, and stale runs', async () => {
    const fixtures = await readEventFixtures();
    const eligible = fixtures.filter(({ event }) => canPublish(event)).map(({ name }) => name);

    expect(eligible).toEqual(['success-push-current.json']);
  });
});
