import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ReviewerGateSnapshot, ReviewFinding } from '../schemas/review.js';

/**
 * Fields signed by the reviewer gate. The signature binds the verdict to a
 * specific review, sprint, attempt, and reviewed commit range so a snapshot
 * cannot be lifted into another review (`review_id`/`sprint_id`), replayed
 * across a different range (`base_sha`/`end_sha`), or survive a re-review
 * (`review_attempt`). `findings`/`summary` are included so they cannot be
 * swapped under an otherwise-valid `accepted` signature.
 */
export interface GateSignaturePayload {
  readonly review_id: string;
  readonly sprint_id: string;
  readonly reviewer: string;
  readonly review_attempt: number;
  readonly verdict: ReviewerGateSnapshot['verdict'];
  readonly base_sha: string;
  readonly end_sha: string;
  readonly reviewed_at: string;
  readonly findings: readonly ReviewFinding[];
  readonly summary?: string | undefined;
}

const PAYLOAD_VERSION = 'rk-gate-v1';

/**
 * Deterministic JSON: object keys sorted recursively so the canonical bytes are
 * independent of insertion order. Required because the snapshot round-trips
 * through YAML frontmatter, which does not preserve key order — sign and verify
 * must agree byte-for-byte regardless of how the object was reconstructed.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Canonical, signable bytes for a gate snapshot. Pure. */
export function canonicalGatePayload(payload: GateSignaturePayload): string {
  return stableStringify({
    v: PAYLOAD_VERSION,
    review_id: payload.review_id,
    sprint_id: payload.sprint_id,
    reviewer: payload.reviewer,
    review_attempt: payload.review_attempt,
    verdict: payload.verdict,
    base_sha: payload.base_sha,
    end_sha: payload.end_sha,
    reviewed_at: payload.reviewed_at,
    findings: payload.findings,
    ...(payload.summary !== undefined ? { summary: payload.summary } : {}),
  });
}

/** HMAC-SHA256 (hex) of the canonical payload. Pure. */
export function signGatePayload(secret: string, payload: GateSignaturePayload): string {
  return createHmac('sha256', secret).update(canonicalGatePayload(payload)).digest('hex');
}

/**
 * Constant-time check that `snapshot.signature` matches an HMAC recomputed from
 * the snapshot's own fields plus the review/sprint binding. Returns false on any
 * mismatch or malformed signature; never throws. Pure.
 */
export function verifyGateSignature(
  secret: string,
  snapshot: ReviewerGateSnapshot,
  binding: { readonly review_id: string; readonly sprint_id: string },
): boolean {
  const expected = signGatePayload(secret, {
    review_id: binding.review_id,
    sprint_id: binding.sprint_id,
    reviewer: snapshot.reviewer,
    review_attempt: snapshot.review_attempt,
    verdict: snapshot.verdict,
    base_sha: snapshot.base_sha,
    end_sha: snapshot.end_sha,
    reviewed_at: snapshot.reviewed_at,
    findings: snapshot.findings,
    summary: snapshot.summary,
  });
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(snapshot.signature, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
