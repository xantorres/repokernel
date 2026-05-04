import { z } from 'zod';

/**
 * Schemas for tracker / PR / external-system integration metadata.
 *
 * Persistence: integration metadata lives under sprint frontmatter
 * `extras.tracker` (or `extras.pr` for PR metadata). RepoKernel does not
 * sync external state into top-level frontmatter — `extras` is the
 * project-private namespace per ADR 49 — so adding a new tracker provider
 * never requires a schema migration of the canonical sprint shape.
 */

export const TRACKER_PROVIDERS = ['linear', 'jira', 'gh'] as const;
export const TrackerProviderSchema = z.enum(TRACKER_PROVIDERS);
export type TrackerProvider = z.infer<typeof TrackerProviderSchema>;

/**
 * Stricter URL schema than `z.string().url()` — Zod's built-in accepts
 * `javascript:`, `data:`, `vbscript:`, `file:`, `ftp:`. Tracker and PR
 * URLs are persisted to disk and rendered back into terminal output and
 * (eventually) third-party UIs. Limiting to `http(s):` keeps the
 * integration safe to surface in any of those contexts.
 */
export const HttpUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const u = new URL(value);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'must be an http(s):// URL' },
  );

export const TrackerMetadataSchema = z
  .object({
    provider: TrackerProviderSchema,
    issue_id: z.string().min(1),
    issue_url: HttpUrlSchema.optional(),
    sync_at: z.string().datetime({ offset: true }),
    synced_fields: z.array(z.enum(['status', 'comment', 'link_pr'])).default([]),
  })
  .strict();

export type TrackerMetadata = z.infer<typeof TrackerMetadataSchema>;

export const PR_PROVIDERS = ['github', 'gitlab', 'bitbucket'] as const;
export const PrProviderSchema = z.enum(PR_PROVIDERS);
export type PrProvider = z.infer<typeof PrProviderSchema>;

export const PR_STATUSES = ['draft', 'open', 'merged', 'closed'] as const;
export const PrStatusSchema = z.enum(PR_STATUSES);
export type PrStatus = z.infer<typeof PrStatusSchema>;

export const PrMetadataSchema = z
  .object({
    provider: PrProviderSchema,
    url: HttpUrlSchema,
    number: z.number().int().positive().optional(),
    status: PrStatusSchema.optional(),
    last_sync_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type PrMetadata = z.infer<typeof PrMetadataSchema>;
