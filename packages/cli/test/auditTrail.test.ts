import { afterAll, describe, expect, it } from 'vitest';
import { runAuditTrailCommand } from '../src/commands/auditTrail.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function sprint(
  id: string,
  status: string,
  extra: Record<string, unknown> = {},
): { path: string; content: string } {
  return {
    path: `sprints/${id}.md`,
    content: fm({
      id,
      title: id,
      epic_id: 'E-001',
      status,
      lane: 'main',
      review_required: false,
      ...extra,
    }),
  };
}

async function project(): Promise<string> {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'Demo', status: 'active', sprints: ['S-001', 'S-002'] }),
    },
    sprint('S-001', 'shipped', { review_id: 'R-001', base_sha: SHA_A, end_sha: SHA_B }),
    sprint('S-002', 'planned'),
    {
      path: 'reviews/R-001.md',
      content: fm({
        id: 'R-001',
        sprint_id: 'S-001',
        verdict: 'accepted',
        reviewer: 'codex',
        findings: [],
        created_at: '2024-01-01T00:00:00Z',
      }),
    },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
  ]);
}

describe('runAuditTrailCommand', () => {
  it('lists each sprint with base/end sha, reviewer, and verdict resolved', async () => {
    const cwd = await project();
    const r = await runAuditTrailCommand({ cwd, epicId: 'E-001', json: true });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as {
      epic_id: string;
      sprints: Array<{
        sprint_id: string;
        status: string;
        reviewer: string | null;
        verdict: string | null;
        base_sha: string | null;
        end_sha: string | null;
        changed_files: number | null;
      }>;
    };
    expect(obj.epic_id).toBe('E-001');
    const byId = Object.fromEntries(obj.sprints.map((s) => [s.sprint_id, s]));
    expect(byId['S-001']).toMatchObject({
      status: 'shipped',
      reviewer: 'codex',
      verdict: 'accepted',
      base_sha: SHA_A,
      end_sha: SHA_B,
      changed_files: null,
    });
    expect(byId['S-002']).toMatchObject({ status: 'planned', reviewer: null, verdict: null });
  });

  it('errors when the epic is missing', async () => {
    const cwd = await project();
    const r = await runAuditTrailCommand({ cwd, epicId: 'E-999', json: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('epic not found');
  });
});
