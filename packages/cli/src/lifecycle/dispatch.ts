/**
 * Dispatch primitives — pure functions used by parallelRunner to bound
 * concurrency and detect stalled agents.
 *
 * The functions here have NO IO. They are intended to be cheap to call
 * inside a hot dispatch loop and are mirrored by simple unit tests.
 */

/**
 * Resolve the effective concurrency cap for a sprint state.
 *
 * Inputs:
 *   - `globalCap`: the project-wide `parallel.maxConcurrentSprints`.
 *   - `byState`: the project-wide `parallel.maxConcurrentSprintsByState`.
 *   - `state`: the state of the sprint being scheduled (e.g. `active`,
 *     `review`).
 *
 * Behaviour:
 *   - The result is always at least 1 — a 0-or-negative cap from a
 *     mis-configured project should not deadlock the runner. The
 *     dispatcher would never spawn a worker, and no recovery path
 *     exists. Returning 1 is the least-surprise minimum.
 *   - The per-state cap is treated as an UPPER bound: it can only
 *     constrain, never raise above the global cap.
 *   - When no per-state override exists, the global cap is used (still
 *     clamped to ≥ 1).
 */
export function effectiveConcurrencyCap(args: {
  readonly globalCap: number;
  readonly byState: Readonly<Record<string, number | undefined>>;
  readonly state: string;
}): number {
  const stateCap = args.byState[args.state];
  if (typeof stateCap === 'number' && stateCap > 0) {
    return Math.max(1, Math.min(args.globalCap, stateCap));
  }
  // The fallback path used to return `args.globalCap` directly, which
  // would surface as 0 if the schema default was overridden by an
  // invalid config injected via the FS. Always clamp.
  return Math.max(1, args.globalCap);
}

export interface WorkerActivity {
  readonly sprintId: string;
  readonly lastActivityAt: number;
  readonly pid?: number;
}

/**
 * Filter `workers` to those whose `lastActivityAt` is older than
 * `thresholdMs` relative to `now`. A `thresholdMs` of 0 disables stall
 * detection — the function returns an empty list, so the caller does
 * not need to special-case the "feature off" path.
 */
export function detectStalledWorkers(
  workers: readonly WorkerActivity[],
  now: number,
  thresholdMs: number,
): readonly WorkerActivity[] {
  if (thresholdMs <= 0) return [];
  return workers.filter((w) => now - w.lastActivityAt > thresholdMs);
}
