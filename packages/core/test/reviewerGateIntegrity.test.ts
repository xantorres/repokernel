import { afterAll, describe, expect, it } from 'vitest';
import { validateProject } from '../src/index.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

const BASE = 'a'.repeat(40);
const SIG = 'b'.repeat(64);

function gatedConfig(): string {
  return `${defaultConfigYaml()}automation:
  defaultReviewer: codex
  reviewers:
    codex:
      authMode: chatgpt
`;
}

const epic = fm({ id: 'E-001', title: 'e', status: 'active', sprints: ['S-001'] });

function shippedSprint(): string {
  return fm({
    id: 'S-001',
    title: 's',
    epic_id: 'E-001',
    status: 'shipped',
    lane: 'main',
    review_required: true,
    review_id: 'R-001',
    base_sha: BASE,
    end_sha: 'c'.repeat(40),
    closed_at: '2026-06-02T00:00:00Z',
  });
}

function review(extra: Record<string, unknown>): string {
  return fm({
    id: 'R-001',
    sprint_id: 'S-001',
    verdict: 'accepted',
    reviewer: 'codex',
    review_attempt: 1,
    created_at: '2026-06-01T00:00:00Z',
    ...extra,
  });
}

function snapshot(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reviewer: 'codex',
    review_attempt: 1,
    verdict: 'accepted',
    findings: [],
    base_sha: BASE,
    end_sha: 'd'.repeat(40),
    reviewed_at: '2026-06-01T12:00:00Z',
    signature: SIG,
    ...extra,
  };
}

async function validate(
  reviewExtra: Record<string, unknown>,
  config = gatedConfig(),
  scope: 'live' | 'all' = 'live',
) {
  const fixture = await makeFixture([
    { path: 'repokernel.config.yaml', content: config },
    { path: 'epics/E-001.md', content: epic },
    { path: 'sprints/S-001.md', content: shippedSprint() },
    { path: 'reviews/R-001.md', content: review(reviewExtra) },
  ]);
  return validateProject({ cwd: fixture.cwd, scope });
}

const has = (r: Awaited<ReturnType<typeof validate>>, code: string) =>
  r.findings.some((f) => f.code === code);

describe('reviewerGateIntegrityRule', () => {
  it('flags a missing snapshot only at audit scope (historical hygiene), not live', async () => {
    expect(has(await validate({}, gatedConfig(), 'live'), 'REVIEWER_GATE_MISSING')).toBe(false);
    expect(has(await validate({}, gatedConfig(), 'all'), 'REVIEWER_GATE_MISSING')).toBe(true);
  });

  it('flags a snapshot whose verdict is not accepted', async () => {
    const r = await validate({ reviewer_gate: snapshot({ verdict: 'changes_requested' }) });
    expect(has(r, 'REVIEWER_GATE_NOT_ACCEPTED')).toBe(true);
  });

  it('flags a snapshot recorded for a stale attempt', async () => {
    const r = await validate({ review_attempt: 2, reviewer_gate: snapshot({ review_attempt: 1 }) });
    expect(has(r, 'REVIEWER_GATE_ATTEMPT_MISMATCH')).toBe(true);
  });

  it('flags a snapshot whose base_sha drifts from the sprint', async () => {
    const r = await validate({ reviewer_gate: snapshot({ base_sha: 'e'.repeat(40) }) });
    expect(has(r, 'REVIEWER_GATE_STALE')).toBe(true);
  });

  it('passes a clean accepted, current-attempt, base-consistent snapshot', async () => {
    const r = await validate({ reviewer_gate: snapshot() });
    expect(has(r, 'REVIEWER_GATE_MISSING')).toBe(false);
    expect(has(r, 'REVIEWER_GATE_NOT_ACCEPTED')).toBe(false);
    expect(has(r, 'REVIEWER_GATE_ATTEMPT_MISMATCH')).toBe(false);
    expect(has(r, 'REVIEWER_GATE_STALE')).toBe(false);
  });

  it('does not fire for a non-gated project (no configured reviewer gate)', async () => {
    const r = await validate({}, defaultConfigYaml());
    expect(has(r, 'REVIEWER_GATE_MISSING')).toBe(false);
  });
});
