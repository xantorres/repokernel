import type { EpicId, RunId, SprintId } from '@repokernel/core';

export interface SprintRunInput {
  readonly run_id: RunId;
  readonly epic_id: EpicId;
  readonly sprint_id: SprintId;
  readonly worktree: string;
  readonly control_cwd: string;
  readonly op_root: string;
  readonly sprint_packet_path: string;
  readonly registry_path: string;
  readonly mode: 'assisted' | 'autonomous';
}

export interface SprintRunReviewResult {
  readonly verdict: 'accepted' | 'changes_requested' | 'rejected';
  readonly findings: Array<{ severity: string; message: string }>;
}

export interface SprintRunResult {
  readonly status: 'completed' | 'blocked' | 'failed';
  readonly summary: string;
  readonly changed_files: string[];
  readonly needs_human: boolean;
  readonly review?: SprintRunReviewResult;
}

export interface AgentRunner {
  readonly name: string;
  runSprint(input: SprintRunInput): Promise<SprintRunResult>;
}
