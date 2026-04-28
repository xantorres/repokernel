import { z } from 'zod';
import { RepoRelativePathSchema } from './path.js';

export const PanelFindingSchema = z.object({
  severity: z.enum(['P0', 'P1', 'P2', 'P3']),
  message: z.string().min(1),
  code: z.string().optional(),
  suggestion: z.string().optional(),
});

export type PanelFinding = z.infer<typeof PanelFindingSchema>;

export const ReviewPanelInputSchema = z
  .object({
    sprint_id: z.string(),
    epic_id: z.string(),
    review_id: z.string(),
    lane: z.string(),
    worktree_path: z.string(),
    changed_files: z.array(RepoRelativePathSchema),
    sprint_packet: z.string(),
  })
  .strict();

export type ReviewPanelInput = z.infer<typeof ReviewPanelInputSchema>;

export const ReviewPanelOutputSchema = z
  .object({
    reviewer_id: z.string().min(1),
    verdict: z.enum(['GREEN', 'YELLOW', 'RED']),
    findings: z.array(PanelFindingSchema).default([]),
    summary: z.string().optional(),
  })
  .strict();

export type ReviewPanelOutput = z.infer<typeof ReviewPanelOutputSchema>;
