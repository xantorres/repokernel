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

export const TASK_ID_RE = /^T-\d+$/;

export type TaskId = `T-${string}`;

export type TaskSource = 'inline' | 'editor' | 'stdin' | 'file';

export interface TaskInput {
  /** Required: short or long prose describing the task. */
  readonly body: string;
  /** Optional: each non-empty line becomes one acceptance criterion. */
  readonly acceptanceCriteria: readonly string[];
  /** Optional: each non-empty line becomes one constraint (e.g. denied path). */
  readonly constraints: readonly string[];
  /** How this task entered RK (for audit). */
  readonly source: TaskSource;
}

/**
 * Persisted alias mapping a task ID to its synthesized epic/sprint pair.
 *
 * Lives at `${config.paths.generated}/tasks/T-NNN.json`. Read-only after the
 * task closes — append a `closed_at` and update `status` only.
 */
export interface TaskAlias {
  readonly id: TaskId;
  readonly epic_id: string;
  readonly sprint_id: string;
  readonly source: TaskSource;
  readonly title: string;
  readonly created_at: string;
  readonly closed_at: string | null;
  readonly status: 'active' | 'review' | 'shipped' | 'cancelled';
}
