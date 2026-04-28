/**
 * Tests for runReviewPanel lifecycle function.
 * Uses fixture shell scripts in test/fixtures/reviewers/.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PanelReviewQualityRule, ReviewPanelInput } from '@repokernel/core';
import { describe, expect, it } from 'vitest';
import { runReviewPanel } from '../src/lifecycle/reviewPanel.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reviewers');

function makeInput(overrides: Partial<ReviewPanelInput> = {}): ReviewPanelInput {
  return {
    sprint_id: 'S-001',
    epic_id: 'E-001',
    review_id: 'R-001',
    lane: 'main',
    worktree_path: '/tmp',
    changed_files: [],
    sprint_packet: 'test sprint packet',
    ...overrides,
  };
}

function makeRule(
  reviewers: PanelReviewQualityRule['reviewers'],
  yellowBlocksClose = false,
): PanelReviewQualityRule {
  return { type: 'panel_review', reviewers, yellow_blocks_close: yellowBlocksClose };
}

// — basic: green reviewer —

describe('runReviewPanel', () => {
  it('resolves GREEN from green.sh fixture', async () => {
    const rule = makeRule([
      {
        id: 'green',
        command: join(FIXTURES, 'green.sh'),
        args: [],
        timeoutSeconds: 10,
        failure_verdict: 'RED',
        env_passthrough: [],
      },
    ]);
    const result = await runReviewPanel(rule, makeInput(), 1);
    expect(result.aggregate).toBe('GREEN');
    expect(result.reviewers).toHaveLength(1);
    expect(result.reviewers[0]!.verdict).toBe('GREEN');
    expect(result.round).toBe(1);
  });

  it('resolves RED from red.sh fixture', async () => {
    const rule = makeRule([
      {
        id: 'red',
        command: join(FIXTURES, 'red.sh'),
        args: [],
        timeoutSeconds: 10,
        failure_verdict: 'RED',
        env_passthrough: [],
      },
    ]);
    const result = await runReviewPanel(rule, makeInput(), 1);
    expect(result.aggregate).toBe('RED');
    expect(result.reviewers[0]!.findings).toHaveLength(1);
  });

  // — aggregate: most-restrictive wins —

  it('mixed green + red → aggregate RED', async () => {
    const rule = makeRule([
      {
        id: 'green',
        command: join(FIXTURES, 'green.sh'),
        args: [],
        timeoutSeconds: 10,
        failure_verdict: 'RED',
        env_passthrough: [],
      },
      {
        id: 'red',
        command: join(FIXTURES, 'red.sh'),
        args: [],
        timeoutSeconds: 10,
        failure_verdict: 'RED',
        env_passthrough: [],
      },
    ]);
    const result = await runReviewPanel(rule, makeInput(), 1);
    expect(result.aggregate).toBe('RED');
  });

  it('mixed green + yellow → aggregate YELLOW', async () => {
    const rule = makeRule([
      {
        id: 'green',
        command: join(FIXTURES, 'green.sh'),
        args: [],
        timeoutSeconds: 10,
        failure_verdict: 'RED',
        env_passthrough: [],
      },
      {
        id: 'yellow',
        command: join(FIXTURES, 'yellow.sh'),
        args: [],
        timeoutSeconds: 10,
        failure_verdict: 'RED',
        env_passthrough: [],
      },
    ]);
    const result = await runReviewPanel(rule, makeInput(), 1);
    expect(result.aggregate).toBe('YELLOW');
  });

  // — timeout: slow reviewer resolves to failure_verdict —

  it('slow reviewer hits SIGTERM and resolves to failure_verdict', async () => {
    const rule = makeRule([
      {
        id: 'slow',
        command: join(FIXTURES, 'slow.sh'),
        args: [],
        timeoutSeconds: 1,
        failure_verdict: 'RED',
        env_passthrough: [],
      },
    ]);
    const start = Date.now();
    const result = await runReviewPanel(rule, makeInput(), 1);
    const elapsed = Date.now() - start;

    expect(result.aggregate).toBe('RED');
    expect(result.reviewers[0]!.verdict).toBe('RED');
    // Must complete well within the slow.sh sleep (999s) — timeout fires at 1s
    expect(elapsed).toBeLessThan(5000);
  }, 8000);

  it('crashing reviewer resolves to failure_verdict', async () => {
    const rule = makeRule([
      {
        id: 'crash',
        command: join(FIXTURES, 'crash.sh'),
        args: [],
        timeoutSeconds: 10,
        failure_verdict: 'YELLOW',
        env_passthrough: [],
      },
    ]);
    const result = await runReviewPanel(rule, makeInput(), 1);
    expect(result.aggregate).toBe('YELLOW');
    expect(result.reviewers[0]!.verdict).toBe('YELLOW');
  });

  // — output limit: reviewer emits too much data —

  it('reviewer stdout output limit resolves to failure_verdict', async () => {
    // 6 MB > MAX_REVIEWER_OUTPUT_BYTES (5 MB)
    const script = `process.stdout.write('x'.repeat(6 * 1024 * 1024))`;
    const rule = makeRule([
      {
        id: 'big-output',
        command: 'node',
        args: ['-e', script],
        timeoutSeconds: 10,
        failure_verdict: 'RED',
        env_passthrough: [],
      },
    ]);
    const result = await runReviewPanel(rule, makeInput(), 1);
    expect(result.aggregate).toBe('RED');
    expect(result.reviewers[0]!.verdict).toBe('RED');
  }, 15_000);

  it('reviewer stderr output limit resolves to failure_verdict', async () => {
    // 6 MB to stderr > MAX_REVIEWER_OUTPUT_BYTES (5 MB)
    const script = `process.stderr.write('x'.repeat(6 * 1024 * 1024))`;
    const rule = makeRule([
      {
        id: 'big-stderr',
        command: 'node',
        args: ['-e', script],
        timeoutSeconds: 10,
        failure_verdict: 'YELLOW',
        env_passthrough: [],
      },
    ]);
    const result = await runReviewPanel(rule, makeInput(), 1);
    expect(result.aggregate).toBe('YELLOW');
    expect(result.reviewers[0]!.verdict).toBe('YELLOW');
  }, 15_000);

  it('combined stdout + stderr exceeding 5 MB resolves to failure_verdict', async () => {
    // Each stream alone is under 5 MB, but combined trips the cap.
    const script = [
      `process.stdout.write('a'.repeat(3 * 1024 * 1024));`,
      `process.stderr.write('b'.repeat(3 * 1024 * 1024));`,
    ].join('\n');
    const rule = makeRule([
      {
        id: 'big-combined',
        command: 'node',
        args: ['-e', script],
        timeoutSeconds: 10,
        failure_verdict: 'RED',
        env_passthrough: [],
      },
    ]);
    const result = await runReviewPanel(rule, makeInput(), 1);
    expect(result.aggregate).toBe('RED');
    expect(result.reviewers[0]!.verdict).toBe('RED');
  }, 15_000);

  // — sentinel size limit —

  it('oversized sentinel payload resolves to failure_verdict', async () => {
    // Write a script that emits >1MB between sentinels
    const script = [
      `const huge = 'x'.repeat(1_100_000);`,
      `process.stdout.write('REPOKERNEL_RESULT_START\\n' + huge + '\\nREPOKERNEL_RESULT_END\\n');`,
    ].join('\n');
    const rule = makeRule([
      {
        id: 'fat',
        command: 'node',
        args: ['-e', script],
        timeoutSeconds: 10,
        failure_verdict: 'RED',
        env_passthrough: [],
      },
    ]);
    const result = await runReviewPanel(rule, makeInput(), 1);
    expect(result.aggregate).toBe('RED');
    expect(result.reviewers[0]!.verdict).toBe('RED');
  });
});
