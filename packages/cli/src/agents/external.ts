import { spawn } from 'node:child_process';
import type { AgentDefinition } from '@repokernel/core';
import type { AgentRunner, SprintRunInput, SprintRunResult } from './types.js';

const SENTINEL_START = 'REPOKERNEL_RESULT_START';
const SENTINEL_END = 'REPOKERNEL_RESULT_END';

function substituteArgs(args: string[], input: SprintRunInput): string[] {
  return args.map((arg) =>
    arg
      .replaceAll('{packet_path}', input.sprint_packet_path)
      .replaceAll('{worktree}', input.worktree)
      .replaceAll('{sprint_id}', input.sprint_id)
      .replaceAll('{run_id}', input.run_id)
      .replaceAll('{epic_id}', input.epic_id)
      .replaceAll('{op_root}', input.op_root)
      .replaceAll('{registry_path}', input.registry_path)
      .replaceAll('{mode}', input.mode),
  );
}

function parseSentinelResult(stdout: string): SprintRunResult {
  const start = stdout.indexOf(SENTINEL_START);
  const end = stdout.indexOf(SENTINEL_END, start);
  if (start === -1 || end === -1) {
    throw new Error(`missing sentinel markers in agent stdout`);
  }
  const raw = stdout.slice(start + SENTINEL_START.length, end).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`agent result is not valid JSON between sentinels`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('status' in parsed) ||
    !('summary' in parsed)
  ) {
    throw new Error(`agent result missing required fields (status, summary)`);
  }
  const r = parsed as Record<string, unknown>;
  if (r.status !== 'completed' && r.status !== 'blocked' && r.status !== 'failed') {
    throw new Error(`agent result has invalid status: ${String(r.status)}`);
  }

  let review: SprintRunResult['review'];
  if (r.review !== null && typeof r.review === 'object') {
    const rv = r.review as Record<string, unknown>;
    if (
      rv.verdict === 'accepted' ||
      rv.verdict === 'changes_requested' ||
      rv.verdict === 'rejected'
    ) {
      review = {
        verdict: rv.verdict,
        findings: Array.isArray(rv.findings)
          ? (rv.findings as Array<Record<string, unknown>>)
              .filter((f) => typeof f === 'object' && f !== null)
              .map((f) => ({
                severity: String(f.severity ?? ''),
                message: String(f.message ?? ''),
              }))
          : [],
      };
    }
  }

  return {
    status: r.status as SprintRunResult['status'],
    summary: typeof r.summary === 'string' ? r.summary : String(r.summary),
    changed_files: Array.isArray(r.changed_files)
      ? (r.changed_files as string[]).filter((f) => typeof f === 'string')
      : [],
    needs_human: r.needs_human === true,
    review,
  };
}

export class ExternalRunner implements AgentRunner {
  readonly name: string;
  private readonly def: AgentDefinition;

  constructor(name: string, def: AgentDefinition) {
    this.name = name;
    this.def = def;
  }

  runSprint(input: SprintRunInput): Promise<SprintRunResult> {
    const args = substituteArgs(this.def.args, input);
    const timeoutMs = this.def.timeoutSeconds * 1000;

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const child = spawn(this.def.command, args, {
        cwd: input.worktree,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`agent timed out after ${this.def.timeoutSeconds}s`));
          return;
        }
        if (code !== 0) {
          reject(
            new Error(
              `agent exited with code ${String(code)}${stderr ? `\n${stderr.slice(0, 500)}` : ''}`,
            ),
          );
          return;
        }
        try {
          resolve(parseSentinelResult(stdout));
        } catch (err) {
          reject(err);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`failed to spawn agent: ${err.message}`));
      });
    });
  }
}

export { parseSentinelResult, substituteArgs };
