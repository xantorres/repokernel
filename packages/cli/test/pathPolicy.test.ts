import { afterAll, describe, expect, it } from 'vitest';
import { runPathPolicyCommand } from '../src/commands/pathPolicy.js';
import { cleanupAllFixtures, defaultConfigYaml, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

interface Policy {
  readonly kind: string;
  readonly reason?: string;
}

async function classify(cwd: string, file: string): Promise<Policy> {
  const r = await runPathPolicyCommand({ cwd, file });
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout) as Policy;
}

async function defaultProject(): Promise<string> {
  return makeFixture([{ path: 'repokernel.config.yaml', content: defaultConfigYaml() }]);
}

function customDirConfigYaml(base: string): string {
  return `schemaVersion: 1
projectId: demo
projectName: Demo
paths:
  epics: ${JSON.stringify(`${base}/plan/epics`)}
  sprints: ${JSON.stringify(`${base}/plan/sprints`)}
  reviews: ${JSON.stringify(`${base}/plan/reviews`)}
  queues: ${JSON.stringify(`${base}/plan/queues`)}
  lanes: ${JSON.stringify(`${base}/plan/lanes`)}
  generated: ${JSON.stringify(base)}
  registry: ${JSON.stringify(`${base}/registry.json`)}
`;
}

describe('rk path-policy', () => {
  it('classifies registry exact match', async () => {
    const cwd = await defaultProject();
    const p = await classify(cwd, '.repokernel/registry.json');
    expect(p.kind).toBe('registry');
    expect(p.reason).toContain('rk registry --write');
  });

  it('classifies sprint markdown', async () => {
    const cwd = await defaultProject();
    const p = await classify(cwd, 'sprints/S-001.md');
    expect(p.kind).toBe('sprint');
    expect(p.reason).toContain('rk start');
  });

  it('classifies epic / queue / review / lane markdown', async () => {
    const cwd = await defaultProject();
    expect((await classify(cwd, 'epics/E-001.md')).kind).toBe('epic');
    expect((await classify(cwd, 'queues/main.md')).kind).toBe('queue');
    expect((await classify(cwd, 'reviews/R-001.md')).kind).toBe('review');
    expect((await classify(cwd, 'lanes/main.md')).kind).toBe('lane');
  });

  it('classifies run logs under generated/runs', async () => {
    const cwd = await defaultProject();
    const p = await classify(cwd, '.repokernel/runs/RUN-001.json');
    expect(p.kind).toBe('run');
  });

  it('classifies authority.md and generated subtree', async () => {
    const cwd = await defaultProject();
    expect((await classify(cwd, '.repokernel/authority.md')).kind).toBe('generated');
    expect((await classify(cwd, '.repokernel/generated/foo.md')).kind).toBe('generated');
  });

  it('returns none for files directly under generated root that are not authority.md or generated/', async () => {
    const cwd = await defaultProject();
    // Only authority.md and generated/ subdir are classified; other files
    // under the base dir fall through to none.
    expect((await classify(cwd, '.repokernel/anything-else.json')).kind).toBe('none');
    // The bare base dir itself (no trailing path) is also none.
    expect((await classify(cwd, '.repokernel')).kind).toBe('none');
  });

  it('returns none for unrelated files', async () => {
    const cwd = await defaultProject();
    expect((await classify(cwd, 'src/index.ts')).kind).toBe('none');
    expect((await classify(cwd, 'README.md')).kind).toBe('none');
  });

  it('returns none when cwd has no RepoKernel config', async () => {
    const cwd = await makeFixture([{ path: 'README.md', content: '# none' }]);
    const p = await classify(cwd, 'sprints/S-001.md');
    expect(p.kind).toBe('none');
  });

  it('classifies correctly under a custom --dir layout', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: customDirConfigYaml('rk') },
    ]);
    expect((await classify(cwd, 'rk/registry.json')).kind).toBe('registry');
    expect((await classify(cwd, 'rk/plan/sprints/S-001.md')).kind).toBe('sprint');
    expect((await classify(cwd, 'rk/plan/epics/E-001.md')).kind).toBe('epic');
    expect((await classify(cwd, 'rk/plan/queues/main.md')).kind).toBe('queue');
    expect((await classify(cwd, 'rk/plan/reviews/R-001.md')).kind).toBe('review');
    expect((await classify(cwd, 'rk/plan/lanes/main.md')).kind).toBe('lane');
    expect((await classify(cwd, 'rk/runs/RUN-001.json')).kind).toBe('run');
    expect((await classify(cwd, 'rk/authority.md')).kind).toBe('generated');
    expect((await classify(cwd, 'rk/generated/foo.md')).kind).toBe('generated');
    expect((await classify(cwd, '.repokernel/registry.json')).kind).toBe('none');
    expect((await classify(cwd, 'src/index.ts')).kind).toBe('none');
  });

  it('handles absolute paths', async () => {
    const cwd = await defaultProject();
    const p = await classify(cwd, `${cwd}/sprints/S-001.md`);
    expect(p.kind).toBe('sprint');
  });

  it('returns none for paths outside the project root', async () => {
    const cwd = await defaultProject();
    const p = await classify(cwd, '/etc/passwd');
    expect(p.kind).toBe('none');
  });
});
