import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandEvidence } from '@repokernel/core';
import matter from 'gray-matter';
import { afterAll, describe, expect, it } from 'vitest';
import { runReviewEvidenceCommand } from '../src/commands/reviewEvidence.js';
import { verifyEvidenceChain } from '../src/lifecycle/reviewEvidence.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

function reviewProject() {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'Chain', status: 'active', sprints: ['S-001'] }),
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
        created_at: '2026-05-20T10:00:00Z',
      }),
    },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
  ]);
}

async function recordTwoExecuted(cwd: string): Promise<CommandEvidence[]> {
  for (const label of ['unit', 'typecheck']) {
    const r = await runReviewEvidenceCommand('S-001', {
      cwd,
      label,
      command: `${process.execPath} -e "process.stdout.write('ok')"`,
      timeoutSeconds: 10,
      json: true,
    });
    expect(r.exitCode).toBe(0);
  }
  const data = matter(await readFile(join(cwd, 'reviews/R-001.md'), 'utf8')).data as {
    command_evidence: CommandEvidence[];
  };
  return data.command_evidence;
}

describe('verifyEvidenceChain — tamper rejection', () => {
  it('a clean recorded chain verifies with zero issues', async () => {
    const cwd = await reviewProject();
    const chain = await recordTwoExecuted(cwd);
    expect(chain).toHaveLength(2);
    expect(verifyEvidenceChain(chain)).toEqual([]);
  });

  it('a naive field tamper is caught at the tampered entry (payload mismatch)', async () => {
    const cwd = await reviewProject();
    const chain = await recordTwoExecuted(cwd);
    // Forge a pass: the recorded command exited 0; rewrite entry 0 to claim
    // a different exit_code/status without recomputing its evidence_hash —
    // the naive tamper. verifyEvidenceChain recomputes the hash over the
    // mutated payload and the stored hash no longer matches.
    const tampered: CommandEvidence[] = [
      { ...chain[0]!, exit_code: 99, status: 'failed' },
      { ...chain[1]! },
    ];
    const issues = verifyEvidenceChain(tampered);
    expect(issues.some((i) => i.index === 0 && /payload/.test(i.reason))).toBe(true);
  });

  it('rewriting one entry hash without fixing the next link breaks the chain', async () => {
    const cwd = await reviewProject();
    const chain = await recordTwoExecuted(cwd);
    // A more careful forge: swap entry 0's evidence_hash to a different
    // value. Even if the attacker matched it to some payload, entry 1's
    // previous_evidence_hash still points at the ORIGINAL hash → the link
    // entry1.previous_evidence_hash === previous fails. Catching a
    // single-entry edit that did not cascade-rewrite the rest of the chain.
    const tampered: CommandEvidence[] = [
      { ...chain[0]!, evidence_hash: 'f'.repeat(64) },
      { ...chain[1]! },
    ];
    const issues = verifyEvidenceChain(tampered);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.index === 1)).toBe(true);
  });

  it('an imported entry is inert — it cannot forge the chain anchor', async () => {
    const cwd = await reviewProject();
    const chain = await recordTwoExecuted(cwd);
    // Splice a hand-crafted `imported` entry between the two executed ones,
    // carrying an attacker-chosen evidence_hash. The chain must still
    // verify: imported entries are skipped, executed→executed continuity
    // holds. Before the fix, the imported entry's bogus hash became the
    // anchor and broke (or forged) the chain.
    const forgedImported: CommandEvidence = {
      label: 'forged',
      status: 'passed',
      ran_at: '2026-05-20T11:00:00Z',
      source: 'imported',
      exit_code: 0,
      evidence_hash: 'deadbeef'.repeat(8),
    };
    const withImported: CommandEvidence[] = [chain[0]!, forgedImported, chain[1]!];
    expect(verifyEvidenceChain(withImported)).toEqual([]);
  });

  it('deleting an executed entry evidence_hash is detected', async () => {
    const cwd = await reviewProject();
    const chain = await recordTwoExecuted(cwd);
    const stripped = { ...chain[0]! };
    delete (stripped as { evidence_hash?: string }).evidence_hash;
    const issues = verifyEvidenceChain([stripped, chain[1]!]);
    expect(issues.some((i) => i.index === 0 && /missing evidence_hash/.test(i.reason))).toBe(true);
  });
});
