import { afterAll, describe, expect, it } from 'vitest';
import { runStartNextCommand } from '../src/commands/startNext.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

const epic = (sprints: string[]) => fm({ id: 'E-001', title: 'demo', status: 'active', sprints });

function sprint(id: string, status: string, extra: Record<string, unknown> = {}): string {
  return fm({
    id,
    title: id,
    epic_id: 'E-001',
    status,
    lane: 'main',
    depends_on: [],
    blocked_by: [],
    allowed_paths: [],
    denied_paths: [],
    generated_paths: [],
    review_required: false,
    ...extra,
  });
}

describe('runStartNextCommand', () => {
  it('reports none when no sprint is runnable or unblocked', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    const r = await runStartNextCommand({ cwd, json: true });
    expect(r.exitCode).not.toBe(0);
    expect(JSON.parse(r.stdout).error.details.result).toBe('none');
  });

  it('would-start an unblocked planned sprint without touching git (dry-run)', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epic(['S-001']) },
      { path: 'sprints/S-001.md', content: sprint('S-001', 'planned') },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const text = await runStartNextCommand({ cwd, json: false, dryRun: true });
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain('Would start S-001');

    const json = await runStartNextCommand({ cwd, json: true, dryRun: true });
    const obj = JSON.parse(json.stdout);
    expect(obj.data.result).toBe('would_start');
    expect(obj.data.sprint_id).toBe('S-001');
  });
});
