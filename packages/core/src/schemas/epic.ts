import { z } from 'zod';
import { EpicIdSchema, SprintIdSchema } from './ids.js';

export const EPIC_STATUSES = ['planned', 'active', 'on_hold', 'done', 'cancelled'] as const;

export const EpicStatusSchema = z.enum(EPIC_STATUSES);
export type EpicStatus = z.infer<typeof EpicStatusSchema>;

export const EpicFrontmatterSchema = z
  .object({
    id: EpicIdSchema,
    title: z.string().min(1),
    status: EpicStatusSchema,
    gate: z.string().min(1).optional(),
    adr_links: z.array(z.string().min(1)).default([]),
    sprints: z.array(SprintIdSchema).default([]),
  })
  .strict();

export type EpicFrontmatter = z.infer<typeof EpicFrontmatterSchema>;

export interface Epic extends EpicFrontmatter {
  readonly file: string;
  readonly body: string;
}
