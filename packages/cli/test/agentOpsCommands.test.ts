import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { runDoctorCommand } from '../src/commands/doctor.js';
import { runEpicCloseCommand } from '../src/commands/epic.js';
import { runNextCommand } from '../src/commands/next.js';
import { runReviewEvidenceCommand } from '../src/commands/reviewEvidence.js';
import { runReviewSprintCommand } from '../src/commands/reviewSprint.js';
import { runSprintNormalizeCommand } from '../src/commands/sprintNormalize.js';
import { runStatusCommand } from '../src/commands/status.js';
import { runWarningsBaselineCommand } from '../src/commands/warnings.js';
import { runWaveClaimCommand } from '../src/commands/waveParallel.js';
import { makeEpicRepo, removeRepo } from './fakeAgent/helpers.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

const gitRepos: string[] = [];

afterEach(async () => {
  await Promise.all(gitRepos.splice(0).map((repo) => removeRepo(repo)));
});

function baseProject(extraSprint: Record<string, unknown> = {}) {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'Agent Ops', status: 'active', sprints: ['S-001'] }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm({
        id: 'S-001',
        title: 'Sprint One',
        epic_id: 'E-001',
        status: 'review',
        lane: 'main',
        review_id: 'R-001',
        allowed_paths: ['src/app.ts'],
        ...extraSprint,
      }),
    },
    {
      path: 'reviews/R-001.md',
      content: fm({
        id: 'R-001',
        sprint_id: 'S-001',
        verdict: 'pending',
        reviewer: 'codex',
        findings: [],
        changed_files: ['src/app.ts'],
        paths_checked: { allowed_paths_matched: true, denied_paths_clean: true },
        created_at: '2026-05-20T10:00:00Z',
      }),
    },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
  ]);
}

describe('10/10 agent-ops command surfaces', () => {
  it('epic close emits a stable JSON envelope', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Done Epic', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Done',
          epic_id: 'E-001',
          status: 'shipped',
          lane: 'main',
          base_sha: 'a'.repeat(40),
          end_sha: 'b'.repeat(40),
          closed_at: '2026-05-20T10:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const result = await runEpicCloseCommand('E-001', {
      cwd,
      dryRun: false,
      force: false,
      json: true,
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      data: { epic_id: string; status: string };
      warnings: unknown[];
      next_actions: unknown[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.data).toMatchObject({ epic_id: 'E-001', status: 'done' });
    expect(Array.isArray(payload.warnings)).toBe(true);
    expect(Array.isArray(payload.next_actions)).toBe(true);
  });

  it('review-evidence executes commands and chains hashed evidence', async () => {
    const cwd = await baseProject();

    const first = await runReviewEvidenceCommand('S-001', {
      cwd,
      label: 'unit',
      command: `${process.execPath} -e "process.stdout.write('ok')"`,
      timeoutSeconds: 10,
      json: true,
    });
    const second = await runReviewEvidenceCommand('S-001', {
      cwd,
      label: 'typecheck',
      command: `${process.execPath} -e "process.stderr.write('warn')"`,
      timeoutSeconds: 10,
      json: true,
    });

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    const review = matter(await readFile(join(cwd, 'reviews/R-001.md'), 'utf8')).data as {
      command_evidence: Array<Record<string, unknown>>;
    };
    expect(review.command_evidence[0]).toMatchObject({
      label: 'unit',
      source: 'executed',
      status: 'passed',
      stdout_bytes: 2,
    });
    expect(review.command_evidence[0]?.stdout_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(review.command_evidence[1]?.previous_evidence_hash).toBe(
      review.command_evidence[0]?.evidence_hash,
    );
  });

  it('review-evidence validates the target before executing the command', async () => {
    const cwd = await baseProject();

    const result = await runReviewEvidenceCommand('S-999', {
      cwd,
      label: 'must-not-run',
      command: `${process.execPath} -e "require('node:fs').writeFileSync('marker.txt','ran')"`,
      timeoutSeconds: 10,
      json: true,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('review not found');
    await expect(readFile(join(cwd, 'marker.txt'), 'utf8')).rejects.toThrow();
  });

  it('imported evidence does not satisfy review-sprint gates', async () => {
    const cwd = await baseProject();
    await runReviewEvidenceCommand('S-001', {
      cwd,
      label: 'manual-proof',
      command: 'pnpm test',
      exitCode: 0,
      json: true,
    });

    const result = await runReviewSprintCommand('S-001', { cwd, dryRun: false, json: true });
    const payload = JSON.parse(result.stdout) as {
      verdict: string;
      findings: Array<{ message: string }>;
    };
    expect(payload.verdict).toBe('changes_requested');
    expect(payload.findings.map((finding) => finding.message)).toContain(
      'imported evidence does not satisfy gates: manual-proof',
    );
  });

  it('sprint normalize materializes generated paths, inferred tests, and review stubs', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Normalize', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Needs defaults',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
          review_required: true,
          allowed_paths: ['src/app.ts'],
          generated_paths: [],
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const result = await runSprintNormalizeCommand({
      cwd,
      target: 'S-001',
      write: true,
      json: true,
    });

    expect(result.exitCode).toBe(0);
    const sprint = matter(await readFile(join(cwd, 'sprints/S-001.md'), 'utf8')).data as {
      review_id: string;
      allowed_paths: string[];
      generated_paths: string[];
    };
    expect(sprint.review_id).toMatch(/^R-\d{3}$/u);
    expect(sprint.allowed_paths).toEqual(
      expect.arrayContaining(['src/app.test.ts', 'src/app.spec.ts']),
    );
    expect(sprint.generated_paths).toEqual([]);
  });

  it('next --claim records an operational claim and status --all-lanes reports lanes', async () => {
    const cwd = await makeEpicRepo({
      sprints: [{ id: 'S-001' }, { id: 'S-002', depends_on: ['S-001'] }],
    });
    gitRepos.push(cwd);

    const next = await runNextCommand({ cwd, json: true, claim: true });
    expect(next.exitCode).toBe(0);
    const nextPayload = JSON.parse(next.stdout) as {
      data: { sprint_id: string; claim: { ok: boolean; runId: string } };
    };
    expect(nextPayload.data.sprint_id).toBe('S-001');
    expect(nextPayload.data.claim.ok).toBe(true);
    await expect(
      readFile(join(cwd, '.git', 'repokernel', 'claims', 'S-001.json'), 'utf8'),
    ).resolves.toContain(nextPayload.data.claim.runId);

    const status = await runStatusCommand({ cwd, json: true, allLanes: true });
    const statusPayload = JSON.parse(status.stdout) as {
      all_lanes: Array<{ lane: string; queued: number }>;
    };
    expect(statusPayload.all_lanes).toEqual(
      expect.arrayContaining([expect.objectContaining({ lane: 'main', queued: 2 })]),
    );
  });

  it('wave claim honors max-per-lane and max-total limits', async () => {
    const cwd = await makeEpicRepo({
      strategy: 'parallel',
      sprints: [{ id: 'S-001' }, { id: 'S-002' }, { id: 'S-003' }],
    });
    gitRepos.push(cwd);

    const result = await runWaveClaimCommand({
      cwd,
      json: true,
      selector: 'E-001',
      maxPerLane: 1,
      maxTotal: 2,
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { claims: Array<{ sprint_id: string }> };
    expect(payload.claims.map((claim) => claim.sprint_id)).toEqual(['S-001']);
  });

  it('wave claim releases partial claims when selected work includes non-queued sprints', async () => {
    const cwd = await makeEpicRepo({
      strategy: 'parallel',
      sprints: [{ id: 'S-001' }, { id: 'S-002' }],
    });
    gitRepos.push(cwd);
    const s002Path = join(cwd, 'sprints', 'S-002.md');
    await writeFile(
      s002Path,
      (await readFile(s002Path, 'utf8')).replace('status: "queued"', 'status: "planned"'),
      'utf8',
    );

    const result = await runWaveClaimCommand({
      cwd,
      json: true,
      selector: 'E-001',
      maxPerLane: 2,
      maxTotal: 2,
    });

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      claims: Array<{ sprint_id: string; ok: boolean }>;
      unclaimable: Array<{ sprint_id: string; status: string }>;
    };
    expect(payload.claims).toEqual([expect.objectContaining({ sprint_id: 'S-001', ok: true })]);
    expect(payload.unclaimable).toEqual([
      expect.objectContaining({ sprint_id: 'S-002', status: 'planned' }),
    ]);
    await expect(
      readFile(join(cwd, '.git', 'repokernel', 'claims', 'S-001.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('warnings baseline and doctor agent-env produce JSON diagnostics', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'package.json', content: '{"packageManager":"pnpm@10.32.1"}\n' },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Diagnostics', status: 'active', sprints: [] }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const baseline = await runWarningsBaselineCommand({
      cwd,
      write: true,
      owner: 'ops',
      expires: '2026-12-31',
      json: true,
    });
    expect(baseline.exitCode).toBe(0);
    await expect(
      readFile(join(cwd, '.repokernel', 'warnings-baseline.json'), 'utf8'),
    ).resolves.toContain('"owner": "ops"');

    const doctor = await runDoctorCommand({ cwd, json: true, agentEnv: true });
    const doctorPayload = JSON.parse(doctor.stdout) as { problems: Array<{ title: string }> };
    expect(doctorPayload.problems.map((problem) => problem.title)).toContain(
      'Dependencies are not installed',
    );
  });
});
