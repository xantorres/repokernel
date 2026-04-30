import { z } from 'zod';
import { LaneNameSchema } from './path.js';

export const LaneFrontmatterSchema = z
  .object({
    name: LaneNameSchema,
    claimed_by: z.string().min(1).optional(),
    claimed_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type LaneFrontmatter = z.infer<typeof LaneFrontmatterSchema>;

export interface Lane extends LaneFrontmatter {
  readonly file: string;
  readonly body: string;
}

export interface LaneState {
  readonly name: string;
  readonly claimed_by?: string;
  readonly claimed_at?: string;
  readonly inferred: boolean;
}
