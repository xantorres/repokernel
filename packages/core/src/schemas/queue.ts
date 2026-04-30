import { z } from 'zod';
import { QueueSlotIdSchema, SprintIdSchema } from './ids.js';
import { LaneNameSchema } from './path.js';

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
    lane: LaneNameSchema,
    slots: z.array(QueueSlotSchema).default([]),
  })
  .strict();

export type QueueFrontmatter = z.infer<typeof QueueFrontmatterSchema>;

export interface Queue extends QueueFrontmatter {
  readonly file: string;
  readonly body: string;
}
