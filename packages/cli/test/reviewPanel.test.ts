/**
 * Tests for runReviewPanel lifecycle function.
 * Uses fixture shell scripts in test/fixtures/reviewers/.
 */

import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearTrustCache,
  type PanelReviewQualityRule,
  type ReviewPanelInput,
} from '@repokernel/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
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

let testCwd: string;
let trustPath: string;
let originalTrustEnv: string | undefined;

beforeEach(() => {
  testCwd = realpathSync(mkdtempSync(join(tmpdir(), 'rk-trust-test-')));
  trustPath = join(testCwd, 'trust.yaml');
  originalTrustEnv = process.env.REPOKERNEL_TRUST_FILE;
  process.env.REPOKERNEL_TRUST_FILE = trustPath;
  clearTrustCache();
});

afterEach(() => {
  if (originalTrustEnv === undefined) delete process.env.REPOKERNEL_TRUST_FILE;
  else process.env.REPOKERNEL_TRUST_FILE = originalTrustEnv;
  clearTrustCache();
});

/**
 * Materialize a user-local trust file granting every reviewer in the rule
 * the command/args declared in the rule. Mirrors what `rk trust audit
 * --apply` would emit for an existing repo. Tests get the cwd back to pass
 * to runReviewPanel.
 */
function seedTrustForRule(rule: PanelReviewQualityRule): string {
  const reviewers: Record<string, unknown> = {};
  for (const r of rule.reviewers) {
    reviewers[r.id] = {
      command: r.command,
      args: r.args,
      env_passthrough: r.env_passthrough,
      timeout_seconds: r.timeoutSeconds,
    };
  }
  const trust = {
    version: 1,
    repos: {
      [testCwd]: { reviewers },
    },
  };
  writeFileSync(trustPath, stringifyYaml(trust));
  clearTrustCache();
  return testCwd;
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
    const cwd = seedTrustForRule(rule);
    const result = await runReviewPanel(rule, makeInput(), 1, cwd);
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
    const cwd = seedTrustForRule(rule);
    const result = await runReviewPanel(rule, makeInput(), 1, cwd);
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
    const cwd = seedTrustForRule(rule);
    const result = await runReviewPanel(rule, makeInput(), 1, cwd);
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
    const cwd = seedTrustForRule(rule);
    const result = await runReviewPanel(rule, makeInput(), 1, cwd);
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
    const cwd = seedTrustForRule(rule);
    const start = Date.now();
    const result = await runReviewPanel(rule, makeInput(), 1, cwd);
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
    const cwd = seedTrustForRule(rule);
    const result = await runReviewPanel(rule, makeInput(), 1, cwd);
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
    const cwd = seedTrustForRule(rule);
    const result = await runReviewPanel(rule, makeInput(), 1, cwd);
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
    const cwd = seedTrustForRule(rule);
    const result = await runReviewPanel(rule, makeInput(), 1, cwd);
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
    const cwd = seedTrustForRule(rule);
    const result = await runReviewPanel(rule, makeInput(), 1, cwd);
    expect(result.aggregate).toBe('RED');
    expect(result.reviewers[0]!.verdict).toBe('RED');
  }, 15_000);

  // — sentinel size limit —

  it('per-reviewer trust failure does NOT abort the whole panel', async () => {
    // One reviewer is trusted (green), the other has no trust grant. The
    // ungranted reviewer must resolve to its failure_verdict; the trusted
    // one must still run normally. Aborting the panel on the first missing
    // grant would surprise users mid-onboarding.
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
        id: 'ungranted',
        command: '/nonexistent/reviewer',
        args: [],
        timeoutSeconds: 10,
        failure_verdict: 'YELLOW',
        env_passthrough: [],
      },
    ]);
    // Seed trust for ONLY the green reviewer — leave 'ungranted' missing.
    const cwd = testCwd;
    process.env.REPOKERNEL_TRUST_FILE = trustPath;
    writeFileSync(
      trustPath,
      stringifyYaml({
        version: 1,
        repos: {
          [cwd]: {
            reviewers: {
              green: {
                command: join(FIXTURES, 'green.sh'),
                args: [],
                env_passthrough: [],
                timeout_seconds: 10,
              },
            },
          },
        },
      }),
    );
    clearTrustCache();
    const result = await runReviewPanel(rule, makeInput(), 1, cwd);
    expect(result.reviewers).toHaveLength(2);
    const byId = Object.fromEntries(result.reviewers.map((r) => [r.reviewer_id, r]));
    expect(byId.green?.verdict).toBe('GREEN');
    expect(byId.ungranted?.verdict).toBe('YELLOW');
    // Aggregate: green + yellow → YELLOW
    expect(result.aggregate).toBe('YELLOW');
  });

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
    const cwd = seedTrustForRule(rule);
    const result = await runReviewPanel(rule, makeInput(), 1, cwd);
    expect(result.aggregate).toBe('RED');
    expect(result.reviewers[0]!.verdict).toBe('RED');
  });
});
