import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCreateSprintsBatchCommand } from '../src/commands/createSprintsBatch.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

async function project(yaml: string): Promise<string> {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'Demo', status: 'active', sprints: [] }),
    },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    { path: 'sprints.yaml', content: yaml },
  ]);
}

describe('runCreateSprintsBatchCommand', () => {
  it('creates contiguous sprints from a valid YAML list', async () => {
    const cwd = await project(`- title: First
  epic: E-001
- title: Second
  epic: E-001
  allowed_paths:
    - src/second.ts
- title: Third
  epic: E-001
`);
    const r = await runCreateSprintsBatchCommand({ cwd, fromFile: 'sprints.yaml', json: true });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as { created: Array<{ id: string }>; count: number };
    expect(obj.count).toBe(3);
    expect(obj.created.map((c) => c.id)).toEqual(['S-001', 'S-002', 'S-003']);
  });

  it('writes nothing when an entry references a missing epic', async () => {
    const cwd = await project(`- title: Good
  epic: E-001
- title: Bad
  epic: E-999
`);
    const r = await runCreateSprintsBatchCommand({ cwd, fromFile: 'sprints.yaml', json: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('E-999 not found');
    const files = await readdir(join(cwd, 'sprints')).catch(() => []);
    expect(files.filter((f) => f.endsWith('.md'))).toHaveLength(0);
  });

  it('rejects --enqueue for a lane with no queue before writing', async () => {
    const cwd = await project(`- title: NeedsQueue
  epic: E-001
  lane: other
  enqueue: true
`);
    const r = await runCreateSprintsBatchCommand({ cwd, fromFile: 'sprints.yaml', json: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('no queue');
  });
});
