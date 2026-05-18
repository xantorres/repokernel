import { type AgentDefinition, AgentSentinelOutputSchema, RepoKernelError } from '@repokernel/core';
import { appendAgentLog } from '../lifecycle/runLogs.js';
import {
  assertAgentTrusted,
  buildPolicyEnv,
  DEFAULT_SPAWN_ENV_ALLOWLIST,
  spawnPolicyPiped,
} from '../security/spawnPolicy.js';
import type { AgentRunner, SprintRunInput, SprintRunResult } from './types.js';

/**
 * Backwards-compatible alias for the spawn-policy env allowlist. Kept so
 * other callers that imported the old name continue to work.
 *
 * @deprecated Import `DEFAULT_SPAWN_ENV_ALLOWLIST` from `security/spawnPolicy`.
 */
const DEFAULT_AGENT_ENV_ALLOWLIST = DEFAULT_SPAWN_ENV_ALLOWLIST;

/**
 * Backwards-compatible alias for `buildPolicyEnv`. Other agent runners and
 * tests import this; we keep the symbol so refactors don't ripple.
 *
 * @deprecated Import `buildPolicyEnv` from `security/spawnPolicy`.
 */
export function buildAgentEnv(
  parentEnv: NodeJS.ProcessEnv,
  passthrough: readonly string[],
): NodeJS.ProcessEnv {
  return buildPolicyEnv(parentEnv, passthrough);
}

const SENTINEL_START = 'REPOKERNEL_RESULT_START';
const SENTINEL_END = 'REPOKERNEL_RESULT_END';
const MAX_SENTINEL_BYTES = 1_048_576; // 1 MB
const MAX_PROCESS_OUTPUT_BYTES = 10 * 1_048_576; // 10 MB
const SIGTERM_GRACE_MS = 5_000;

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
    throw new RepoKernelError(
      'INVALID_SENTINEL_OUTPUT',
      `missing sentinel markers (${SENTINEL_START} / ${SENTINEL_END}) in agent stdout`,
    );
  }
  const raw = stdout.slice(start + SENTINEL_START.length, end).trim();
  if (raw.length > MAX_SENTINEL_BYTES) {
    throw new RepoKernelError(
      'INVALID_SENTINEL_OUTPUT',
      `agent sentinel payload exceeds ${MAX_SENTINEL_BYTES} byte limit`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new RepoKernelError(
      'INVALID_SENTINEL_OUTPUT',
      `agent result is not valid JSON between sentinels: ${(cause as Error).message}`,
      cause,
    );
  }

  const validated = AgentSentinelOutputSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new RepoKernelError(
      'INVALID_SENTINEL_OUTPUT',
      `agent sentinel output failed schema validation: ${issues}`,
    );
  }
  const r = validated.data;

  return {
    status: r.status,
    summary: r.summary,
    changed_files: r.changed_files,
    needs_human: r.needs_human,
    ...(r.review ? { review: { verdict: r.review.verdict, findings: r.review.findings } } : {}),
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

  async runSprint(input: SprintRunInput): Promise<SprintRunResult> {
    validatePlaceholders(this.def.args);
    const trust = await assertAgentTrusted(this.name, this.def, input.control_cwd);
    for (const dropped of trust.droppedEnv) {
      void appendAgentLog(
        input.run_id,
        input.sprint_id,
        `[trust] dropping env ${dropped.name}: ${dropped.reason}`,
        input.op_root,
      );
    }

    return new Promise((resolve, reject) => {
      const args = substituteArgs(this.def.args, input);
      const timeoutMs = this.def.timeoutSeconds * 1000;
      const command = this.def.command;

      let stdout = '';
      let stderr = '';
      let stdoutPending = '';
      let stderrPending = '';
      let terminationReason: 'timeout' | 'output_limit' | null = null;

      const { child, untrack: untrackChild } = spawnPolicyPiped({
        command,
        args,
        cwd: input.worktree,
        envPassthrough: trust.allowedEnv,
      });

      let killTimer: NodeJS.Timeout | null = null;
      const killProcessTree = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          if (process.platform === 'win32') {
            child.kill(signal);
          } else {
            process.kill(-child.pid, signal);
          }
        } catch {
          // Already exited.
        }
      };
      const terminate = (reason: 'timeout' | 'output_limit') => {
        if (terminationReason) return;
        terminationReason = reason;
        killProcessTree('SIGTERM');
        killTimer = setTimeout(() => {
          killProcessTree('SIGKILL');
        }, SIGTERM_GRACE_MS);
      };

      const timer = setTimeout(() => {
        void appendAgentLog(
          input.run_id,
          input.sprint_id,
          `[timeout] killing ${command} after ${this.def.timeoutSeconds / 60}m`,
          input.op_root,
        );
        terminate('timeout');
      }, timeoutMs);

      const outputTooLarge = (nextChunkBytes: number) =>
        Buffer.byteLength(stdout) +
          Buffer.byteLength(stderr) +
          Buffer.byteLength(stdoutPending) +
          Buffer.byteLength(stderrPending) +
          nextChunkBytes >
        MAX_PROCESS_OUTPUT_BYTES;

      child.stdout.on('data', (chunk: Buffer) => {
        if (outputTooLarge(chunk.byteLength)) {
          terminate('output_limit');
          return;
        }
        stdoutPending += chunk.toString('utf8');
        const lines = stdoutPending.split('\n');
        stdoutPending = lines.pop() ?? '';
        for (const line of lines) {
          stdout += `${line}\n`;
          if (line) void appendAgentLog(input.run_id, input.sprint_id, line, input.op_root);
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        if (outputTooLarge(chunk.byteLength)) {
          terminate('output_limit');
          return;
        }
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
        untrackChild();
        if (killTimer) clearTimeout(killTimer);
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
        if (terminationReason === 'timeout') {
          reject(new Error(`agent timed out after ${this.def.timeoutSeconds}s`));
          return;
        }
        if (terminationReason === 'output_limit') {
          reject(new Error(`agent output exceeded ${MAX_PROCESS_OUTPUT_BYTES} byte limit`));
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
        untrackChild();
        clearTimeout(timer);
        reject(new Error(`failed to spawn agent: ${err.message}`));
      });
    });
  }
}

export { DEFAULT_AGENT_ENV_ALLOWLIST, parseSentinelResult, substituteArgs, validatePlaceholders };
