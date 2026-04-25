import { z } from 'zod';

export const SPRINT_ID_RE = /^S-\d+$/;
export const EPIC_ID_RE = /^E-\d+$/;
export const REVIEW_ID_RE = /^R-\d+$/;
export const QUEUE_SLOT_ID_RE = /^Q-\d+$/;
export const RUN_ID_RE = /^RUN-\d+$/;
export const SHA_RE = /^[0-9a-f]{7,40}$/;

export const SprintIdSchema = z.string().regex(SPRINT_ID_RE);
export const EpicIdSchema = z.string().regex(EPIC_ID_RE);
export const ReviewIdSchema = z.string().regex(REVIEW_ID_RE);
export const QueueSlotIdSchema = z.string().regex(QUEUE_SLOT_ID_RE);
export const RunIdSchema = z.string().regex(RUN_ID_RE);
export const ShaSchema = z.string().regex(SHA_RE);

export type SprintId = z.infer<typeof SprintIdSchema>;
export type EpicId = z.infer<typeof EpicIdSchema>;
export type ReviewId = z.infer<typeof ReviewIdSchema>;
export type QueueSlotId = z.infer<typeof QueueSlotIdSchema>;
export type RunId = z.infer<typeof RunIdSchema>;
export type Sha = z.infer<typeof ShaSchema>;
