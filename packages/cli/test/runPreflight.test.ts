import { loadProject } from '@repokernel/core';
import { describe, expect, it } from 'vitest';
import { runRunCommand } from '../src/commands/run.js';
import { epicPreflight } from '../src/commands/runPreflight.js';
import { makeEpicRepo } from './fakeAgent/helpers.js';

async function preflightFor(repo: string) {
  const outcome = await loadProject({ cwd: repo });
  if (!outcome.ok) throw new Error('project failed to load');
  return epicPreflight({
    cwd: repo,
    epicId: 'E-001',
    lane: 'main',
    agentName: 'fake',
    strategy: 'sequential',
    config: outcome.config,
    outcome,
  });
}

describe('epicPreflight', () => {
  it('passes a healthy epic with a queued runnable sprint', async () => {
    const repo = await makeEpicRepo({ sprints: [{ id: 'S-001' }] });
    const result = await preflightFor(repo);

    expect(result.blocking).toBe(false);
    expect(result.runnableSprintCount).toBe(1);
    expect(result.checks.find((c) => c.id === 'runnable-sprints')?.status).toBe('pass');
    expect(result.checks.find((c) => c.id === 'trust')?.status).toBe('pass');
  });

  it('does not block when the first sprint is gated — the run will pause at it', async () => {
    const repo = await makeEpicRepo({ sprints: [{ id: 'S-001', gate: 'design-review' }] });
    const result = await preflightFor(repo);

    expect(result.blocking).toBe(false);
    expect(result.checks.find((c) => c.id === 'runnable-sprints')?.status).toBe('pass');
  });

  it('blocks when no sprint is runnable on the target lane', async () => {
    const repo = await makeEpicRepo({ sprints: [{ id: 'S-001' }] });
    const outcome = await loadProject({ cwd: repo });
    if (!outcome.ok) throw new Error('project failed to load');
    const result = await epicPreflight({
      cwd: repo,
      epicId: 'E-001',
      lane: 'other-lane',
      agentName: 'fake',
      strategy: 'sequential',
      config: outcome.config,
      outcome,
    });

    expect(result.blocking).toBe(true);
    expect(result.runnableSprintCount).toBe(0);
    expect(result.checks.find((c) => c.id === 'runnable-sprints')?.status).toBe('fail');
  });
});

describe('rk run --preflight', () => {
  it('renders the read-only pre-flight report and writes nothing', async () => {
    const repo = await makeEpicRepo({ sprints: [{ id: 'S-001' }] });
    const result = await runRunCommand({
      cwd: repo,
      epicId: 'E-001',
      mode: 'assisted',
      agent: 'fake',
      worktree: false,
      dryRun: false,
      preflight: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Pre-flight checks:');
    expect(result.stdout).toContain('runnable-sprints');
    expect(result.stdout).toContain('No files written.');
  });
});
