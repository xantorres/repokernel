import { z } from 'zod';
import { QueueSlotIdSchema, SprintIdSchema } from './ids.js';

export const QueueSlotSchema = z
  .object({
    id: QueueSlotIdSchema,
    sprint_id: SprintIdSchema,
    order: z.number().int().nonnegative(),
  })
  .strict();
export type QueueSlot = z.infer<typeof QueueSlotSchema>;

export const QueueFrontmatterSchema = z
  .object({
    lane: z.string().min(1),
    slots: z.array(QueueSlotSchema).default([]),
  })
  .strict();

export type QueueFrontmatter = z.infer<typeof QueueFrontmatterSchema>;

export interface Queue extends QueueFrontmatter {
  readonly file: string;
  readonly body: string;
}
