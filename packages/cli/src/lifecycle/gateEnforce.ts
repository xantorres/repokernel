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
import { changedFilesSince, fileAtCommit } from './git.js';
import { parseSprintScope } from './reviewerGate.js';

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
 * snapshot is authentic (signature), produced by the review's stamped reviewer,
 * bound to the current attempt, accepted, and fresh against the committed tree
 * AND the policy/scope inputs that defined it. Otherwise returns the blocking
 * reason.
 *
 * Always-on: not bypassable with `--skip-checks`. The signature is verified
 * against the SPRINT BEING CLOSED (`sprint.id`) — never the review's own
 * `sprint_id` field — so a sprint pointing at another sprint's signed review
 * fails closed. Requirement is anchored on config + `review_required` + the
 * linked review, so a gated reviewer cannot be dodged by renaming.
 */
export async function evaluateReviewerGate(opts: {
  readonly checkPath: string;
  readonly config: Config;
  readonly sprint: Sprint;
  readonly review: Review;
  /** Repo-relative path to the project config — a post-gate edit to it is stale-making. */
  readonly configFile: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<GateEvaluation> {
  const { checkPath, config, sprint, review, configFile } = opts;
  if (!gateRequired(sprint, config, review)) return OK;

  const reviewGateHint = `rk review-gate ${sprint.id}`;

  // A review that targets another sprint must never satisfy this sprint's gate.
  if (review.sprint_id !== sprint.id) {
    return {
      ok: false,
      block: {
        code: 'REVIEWER_GATE_MISSING',
        message: `${sprint.id} links review ${review.id}, which targets sprint ${review.sprint_id}`,
        hint: `link a review for ${sprint.id} and run ${reviewGateHint}`,
      },
    };
  }

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

  // The local signing key is shared across reviewers, so the signature alone
  // does not prove WHICH reviewer produced the snapshot. Bind it to the review's
  // stamped reviewer explicitly.
  if (snapshot.reviewer !== review.reviewer) {
    return {
      ok: false,
      block: {
        code: 'REVIEWER_GATE_SIGNATURE_INVALID',
        message: `${review.id} is stamped reviewer "${review.reviewer}" but its reviewer_gate was produced by "${snapshot.reviewer}"`,
        hint: `run the gate as the stamped reviewer: ${reviewGateHint}`,
      },
    };
  }

  const secret = await loadGateSecret(opts.env);
  if (
    secret === null ||
    !verifyGateSignature(secret, snapshot, { review_id: review.id, sprint_id: sprint.id })
  ) {
    return {
      ok: false,
      block: {
        code: 'REVIEWER_GATE_SIGNATURE_INVALID',
        message:
          secret === null
            ? `${review.id} has a reviewer_gate snapshot but no local gate key is available to verify it`
            : `${review.id} reviewer_gate signature does not verify — the snapshot was forged, lifted from another sprint, or signed on another machine`,
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

  // The snapshot's base_sha is the signed start of the reviewed range and the
  // commit its scope was read at. If the sprint's base_sha has since been
  // retargeted (rebase or metadata tamper), the shipped audit range no longer
  // matches what was signed — block here, not just post-ship at validate.
  if (sprint.base_sha && snapshot.base_sha !== sprint.base_sha) {
    return {
      ok: false,
      block: {
        code: 'REVIEWER_GATE_STALE',
        message: `${review.id} gated base ${snapshot.base_sha.slice(0, 7)} but ${sprint.id} base_sha is now ${sprint.base_sha.slice(0, 7)}`,
        hint: `re-run the reviewer gate against the current base: ${reviewGateHint}`,
      },
    };
  }

  const sinceReview = await changedFilesSince(checkPath, snapshot.end_sha);

  // Policy/scope freshness. The gate's verdict is only valid for the scope
  // (allowed/denied/generated paths) and the project policy it reviewed. A
  // post-gate edit to the project config, or to the sprint's scope fields,
  // re-defines what "in scope" or "requires a gate" means — so the snapshot no
  // longer vouches for the current tree. The sprint file's status/metadata
  // churn (active→review→shipped) is NOT scope, so compare the scope fields
  // directly rather than the raw file change.
  if (sinceReview.includes(configFile)) {
    return {
      ok: false,
      block: {
        code: 'REVIEWER_GATE_STALE',
        message: `${review.id} gated ${snapshot.end_sha.slice(0, 7)}; project config ${configFile} changed since`,
        hint: `re-run the reviewer gate against the current policy: ${reviewGateHint}`,
      },
    };
  }
  const scopeAtGate = await fileAtCommit(checkPath, snapshot.base_sha, sprint.file).then((c) =>
    c === null ? null : parseSprintScope(c),
  );
  const norm = (a: readonly string[] | undefined): string => JSON.stringify([...(a ?? [])].sort());
  const scopeDrifted =
    scopeAtGate === null ||
    norm(scopeAtGate.allowed_paths) !== norm(sprint.allowed_paths) ||
    norm(scopeAtGate.denied_paths) !== norm(sprint.denied_paths) ||
    norm(scopeAtGate.generated_paths) !== norm(sprint.generated_paths);
  if (scopeDrifted) {
    return {
      ok: false,
      block: {
        code: 'REVIEWER_GATE_STALE',
        message: `${review.id} gated against a different scope than the current ${sprint.file}`,
        hint: `re-run the reviewer gate against the current scope: ${reviewGateHint}`,
      },
    };
  }

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
