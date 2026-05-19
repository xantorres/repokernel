import { z } from 'zod';
import { EpicIdSchema, ShaSchema, SprintIdSchema } from './ids.js';

export const TaskIdSchema = z.string().regex(/^T-\d+$/u, 'must match T-NNN');
export type TaskId = z.infer<typeof TaskIdSchema>;

export const TaskSourceSchema = z.enum(['inline', 'editor', 'stdin', 'file', 'tracker']);
export type TaskSource = z.infer<typeof TaskSourceSchema>;

export const TaskTrackerMetadataSchema = z
  .object({
    source: z.enum(['jira', 'linear', 'gh']),
    ref: z.string().min(1),
    id: z.string().min(1),
    url: z.string().min(1),
    labels: z.array(z.string()).default([]),
    assignee: z.string().nullable(),
  })
  .strict();
export type TaskTrackerMetadata = z.infer<typeof TaskTrackerMetadataSchema>;

export const TASK_ALIAS_STATUSES = ['active', 'review', 'shipped', 'cancelled'] as const;
export const TaskAliasStatusSchema = z.enum(TASK_ALIAS_STATUSES);
export type TaskAliasStatus = z.infer<typeof TaskAliasStatusSchema>;

/**
 * Persisted alias mapping a task id (`T-NNN`) to its synthesized epic/sprint
 * pair. Lives at `<paths.generated>/tasks/T-NNN.json`. Strict on the way in:
 * any unknown key indicates an alias hand-edit or schema drift and is
 * rejected at parse time so `rk doctor` can quarantine the bad file rather
 * than the command crashing mid-flight.
 *
 * The status/closed_at consistency rule (shipped/cancelled ⇒ closed_at !==
 * null) is intentionally NOT enforced at the schema level — that's a
 * project-level invariant carried by a validator rule so it can surface as
 * a Finding rather than a parse rejection. The schema's job is shape;
 * lifecycle invariants live in the validator.
 */
export const TaskAliasSchema = z
  .object({
    id: TaskIdSchema,
    epic_id: EpicIdSchema,
    sprint_id: SprintIdSchema,
    source: TaskSourceSchema,
    title: z.string().min(1),
    created_at: z.string().datetime({ offset: true }),
    closed_at: z.string().datetime({ offset: true }).nullable(),
    status: TaskAliasStatusSchema,
    review_sha: ShaSchema.nullable().optional(),
    tracker: TaskTrackerMetadataSchema.optional(),
  })
  .strict();

export type TaskAlias = z.infer<typeof TaskAliasSchema>;

/**
 * Parse `data` as a task alias and additionally enforce that the filename
 * (without `.json`) matches `alias.id`. Catches the renamed-file class of
 * corruption (`T-001.json` whose body claims `id: T-099` because a user
 * copy-pasted the file). Returns `{ ok: true; alias }` or `{ ok: false; error }`
 * — never throws — because the typical caller is a `rk doctor` walk that
 * needs to enumerate problems rather than fail on the first one.
 */
export function parseTaskAlias(
  data: unknown,
  filenameWithoutExt?: string,
):
  | { readonly ok: true; readonly alias: TaskAlias }
  | { readonly ok: false; readonly error: string } {
  const parsed = TaskAliasSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `task alias failed validation: ${issues}` };
  }
  if (filenameWithoutExt !== undefined && filenameWithoutExt !== parsed.data.id) {
    return {
      ok: false,
      error: `task alias id '${parsed.data.id}' does not match filename '${filenameWithoutExt}.json'`,
    };
  }
  return { ok: true, alias: parsed.data };
}
