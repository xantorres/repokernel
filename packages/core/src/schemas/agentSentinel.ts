import { z } from 'zod';
import { SeveritySchema } from './finding.js';

export const AGENT_STATUS = ['completed', 'blocked', 'failed'] as const;
export const AGENT_REVIEW_VERDICT = ['accepted', 'changes_requested', 'rejected'] as const;

export const AgentSentinelReviewFindingSchema = z
  .object({
    severity: SeveritySchema,
    message: z.string().min(1),
  })
  .strict();
export type AgentSentinelReviewFinding = z.infer<typeof AgentSentinelReviewFindingSchema>;

export const AgentSentinelReviewSchema = z
  .object({
    verdict: z.enum(AGENT_REVIEW_VERDICT),
    findings: z.array(AgentSentinelReviewFindingSchema).default([]),
  })
  .strict();
export type AgentSentinelReview = z.infer<typeof AgentSentinelReviewSchema>;

export const AgentSentinelOutputSchema = z
  .object({
    status: z.enum(AGENT_STATUS),
    summary: z.string().min(1),
    changed_files: z.array(z.string()).default([]),
    needs_human: z.boolean().default(false),
    review: AgentSentinelReviewSchema.nullable().optional(),
  })
  .strict();
export type AgentSentinelOutput = z.infer<typeof AgentSentinelOutputSchema>;
