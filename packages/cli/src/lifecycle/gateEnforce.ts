import {
  type Config,
  gateRequired,
  loadGateSecret,
  materialPathGlobs,
  type Review,
  reviewerGateConfigFor,
  type Sprint,
  verifyGateSignature,
} from '@repokernel/core';
import { inScopeFiles } from './diffClassifier.js';
import { changedFilesSince } from './git.js';

export interface GateBlock {
  readonly code:
    | 'REVIEWER_GATE_MISSING'
    | 'REVIEWER_GATE_NOT_ACCEPTED'
    | 'REVIEWER_GATE_ATTEMPT_MISMATCH'
    | 'REVIEWER_GATE_STALE'
    | 'REVIEWER_GATE_SIGNATURE_INVALID';
  readonly message: string;
  readonly hint: string;
}

export type GateEvaluation =
  | { readonly ok: true }
  | { readonly ok: false; readonly block: GateBlock };

const OK: GateEvaluation = { ok: true };

/**
 * Evaluate the signed reviewer_gate snapshot as a close/ship precondition.
 * Returns `ok` when no gate is required for the sprint, or when a present
 * snapshot is authentic (signature), bound to the current attempt, accepted,
 * and fresh against the committed tree. Otherwise returns the blocking reason.
 *
 * Always-on: this is not bypassable with `--skip-checks`. Anchored on config +
 * the sprint's `review_required`, so a snapshot/review cannot dodge the gate by
 * renaming its reviewer.
 */
export async function evaluateReviewerGate(opts: {
  readonly checkPath: string;
  readonly config: Config;
  readonly sprint: Sprint;
  readonly review: Review;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<GateEvaluation> {
  const { checkPath, config, sprint, review } = opts;
  if (!gateRequired(sprint, config)) return OK;

  const reviewGateHint = `rk review-gate ${sprint.id}`;

  if (reviewerGateConfigFor(config.automation, review.reviewer) === undefined) {
    return {
      ok: false,
      block: {
        code: 'REVIEWER_GATE_MISSING',
        message: `review ${review.id} reviewer "${review.reviewer}" has no configured reviewer gate, but ${sprint.id} requires one`,
        hint: `stamp a configured reviewer (automation.reviewers) and run ${reviewGateHint}`,
      },
    };
  }

  const snapshot = review.reviewer_gate;
  if (!snapshot) {
    return {
      ok: false,
      block: {
        code: 'REVIEWER_GATE_MISSING',
        message: `${sprint.id} requires a reviewer gate but ${review.id} has no reviewer_gate snapshot`,
        hint: `run the reviewer gate: ${reviewGateHint}`,
      },
    };
  }

  const secret = await loadGateSecret(opts.env);
  if (
    secret === null ||
    !verifyGateSignature(secret, snapshot, {
      review_id: review.id,
      sprint_id: review.sprint_id,
    })
  ) {
    return {
      ok: false,
      block: {
        code: 'REVIEWER_GATE_SIGNATURE_INVALID',
        message:
          secret === null
            ? `${review.id} has a reviewer_gate snapshot but no local gate key is available to verify it`
            : `${review.id} reviewer_gate signature does not verify — the snapshot was forged or signed on another machine`,
        hint: `re-run the gate on the machine that holds the gate key: ${reviewGateHint}`,
      },
    };
  }

  if (snapshot.review_attempt !== review.review_attempt) {
    return {
      ok: false,
      block: {
        code: 'REVIEWER_GATE_ATTEMPT_MISMATCH',
        message: `${review.id} reviewer_gate is for attempt ${snapshot.review_attempt} but the current review attempt is ${review.review_attempt}`,
        hint: `re-run the gate for the current attempt: ${reviewGateHint}`,
      },
    };
  }

  if (snapshot.verdict !== 'accepted') {
    return {
      ok: false,
      block: {
        code: 'REVIEWER_GATE_NOT_ACCEPTED',
        message: `${review.id} reviewer_gate verdict is ${snapshot.verdict}`,
        hint: `address the gate findings, commit, then re-run: ${reviewGateHint}`,
      },
    };
  }

  const sinceReview = await changedFilesSince(checkPath, snapshot.end_sha);
  const changedInScope = inScopeFiles(sinceReview, {
    config,
    sprint,
    rkOwnedGlobs: materialPathGlobs(config),
    exemptPaths: [
      sprint.file,
      config.paths.registry,
      `${config.paths.queues}/${sprint.lane}.md`,
      review.file,
    ],
  });
  if (changedInScope.length > 0) {
    return {
      ok: false,
      block: {
        code: 'REVIEWER_GATE_STALE',
        message: `${review.id} gated ${snapshot.end_sha.slice(0, 7)}; in-scope files changed since: ${changedInScope.join(', ')}`,
        hint: `re-run the reviewer gate: ${reviewGateHint}`,
      },
    };
  }

  return OK;
}
