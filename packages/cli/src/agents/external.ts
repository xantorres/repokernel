import { spawn } from 'node:child_process';
import { type AgentDefinition, RepoKernelError } from '@repokernel/core';
import { appendAgentLog } from '../lifecycle/runLogs.js';
import type { AgentRunner, SprintRunInput, SprintRunResult } from './types.js';

const SENTINEL_START = 'REPOKERNEL_RESULT_START';
const SENTINEL_END = 'REPOKERNEL_RESULT_END';
const MAX_SENTINEL_BYTES = 1_048_576; // 1 MB

const ALLOWED_PLACEHOLDERS = new Set([
  '{worktree}',
  '{packet_path}',
  '{sprint_id}',
  '{run_id}',
  '{op_root}',
  '{epic_id}',
  '{registry_path}',
  '{mode}',
]);

function validatePlaceholders(args: string[]): void {
  for (const arg of args) {
    for (const match of arg.matchAll(/\{[a-z][a-z_]*\}/g)) {
      if (!ALLOWED_PLACEHOLDERS.has(match[0])) {
        throw new RepoKernelError(
          'INTERNAL',
          `unknown placeholder "${match[0]}" in agent args (allowed: ${[...ALLOWED_PLACEHOLDERS].join(', ')})`,
        );
      }
    }
  }
}

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
  if (raw.length > MAX_SENTINEL_BYTES) throw new Error('agent sentinel payload exceeds 1 MB limit');
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
    ...(review !== undefined ? { review } : {}),
  };
}

export class ExternalRunner implements AgentRunner {
  readonly name: string;
  private readonly def: AgentDefinition;

  constructor(name: string, def: AgentDefinition) {
    this.name = name;
    this.def = def;
  }

  get command(): string {
    return this.def.command;
  }

  runSprint(input: SprintRunInput): Promise<SprintRunResult> {
    return new Promise((resolve, reject) => {
      try {
        validatePlaceholders(this.def.args);
      } catch (err) {
        reject(err);
        return;
      }

      const args = substituteArgs(this.def.args, input);
      const timeoutMs = this.def.timeoutSeconds * 1000;
      const command = this.def.command;

      let stdout = '';
      let stderr = '';
      let stdoutPending = '';
      let stderrPending = '';
      let timedOut = false;

      const child = spawn(command, args, {
        cwd: input.worktree,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        void appendAgentLog(
          input.run_id,
          input.sprint_id,
          `[timeout] killing ${command} after ${this.def.timeoutSeconds / 60}m`,
          input.op_root,
        );
        child.kill('SIGTERM');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutPending += chunk.toString('utf8');
        const lines = stdoutPending.split('\n');
        stdoutPending = lines.pop() ?? '';
        for (const line of lines) {
          stdout += `${line}\n`;
          if (line) void appendAgentLog(input.run_id, input.sprint_id, line, input.op_root);
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrPending += chunk.toString('utf8');
        const lines = stderrPending.split('\n');
        stderrPending = lines.pop() ?? '';
        for (const line of lines) {
          stderr += `${line}\n`;
          if (line)
            void appendAgentLog(input.run_id, input.sprint_id, `[stderr] ${line}`, input.op_root);
        }
      });

      child.on('close', (code) => {
        if (stdoutPending) {
          stdout += stdoutPending;
          void appendAgentLog(input.run_id, input.sprint_id, stdoutPending, input.op_root);
        }
        if (stderrPending) {
          stderr += stderrPending;
          void appendAgentLog(
            input.run_id,
            input.sprint_id,
            `[stderr] ${stderrPending}`,
            input.op_root,
          );
        }

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

export { parseSentinelResult, substituteArgs, validatePlaceholders };
