/**
 * Public types for the fastpath layer.
 *
 * Fastpath wraps the existing epic/sprint machinery so users can run a single
 * coding task end-to-end without ceremony:
 *
 *   rk run -m "Add /health endpoint" --agent claude
 *   rk close T-001
 *
 * Internally each task synthesizes a one-sprint epic. The "task-ness" lives
 * exclusively in an alias file (`.repokernel/tasks/T-NNN.json`); the epic and
 * sprint files conform to the existing schemas with no modification.
 */

import type { TaskSource, TaskTrackerMetadata } from '@repokernel/core';

export const TASK_ID_RE = /^T-\d+$/u;

export type { TaskAlias, TaskId, TaskSource, TaskTrackerMetadata } from '@repokernel/core';

export interface TaskInput {
  /** Required: short or long prose describing the task. */
  readonly body: string;
  /** Optional: each non-empty line becomes one acceptance criterion. */
  readonly acceptanceCriteria: readonly string[];
  /** Optional: each non-empty line becomes one constraint (e.g. denied path). */
  readonly constraints: readonly string[];
  /** Optional: repo-relative globs the task may touch. */
  readonly allowedPaths?: readonly string[];
  /** Optional: repo-relative globs the task must not touch. */
  readonly deniedPaths?: readonly string[];
  /** How this task entered RK (for audit). */
  readonly source: TaskSource;
  /** Optional tracker linkage when the task was seeded from an external issue. */
  readonly tracker?: TaskTrackerMetadata;
}
