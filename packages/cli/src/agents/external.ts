import { spawn } from 'node:child_process';
import { type AgentDefinition, RepoKernelError } from '@repokernel/core';
import { trackActiveChild } from '../lifecycle/abortHandler.js';
import { appendAgentLog } from '../lifecycle/runLogs.js';
import type { AgentRunner, SprintRunInput, SprintRunResult } from './types.js';

/**
 * Default env vars passed through to externally-configured agents. Anything
 * else from the parent process environment (OPENAI_API_KEY, AWS_*, GCP_*,
 * etc.) is dropped unless explicitly opted in via
 * `agents.<name>.envPassthrough` in the config. This narrows the blast
 * radius of a misbehaving or compromised agent: even if the agent's
 * command exfiltrates env, there is nothing repo-irrelevant to leak.
 *
 * The list is the minimal set required for normal POSIX shell tooling:
 * PATH so the agent can find binaries it depends on; HOME/SHELL/TERM for
 * tools that key off them; TMPDIR/TEMP for temp-file writes; CI so
 * tooling can detect non-interactive mode.
 */
const DEFAULT_AGENT_ENV_ALLOWLIST: readonly string[] = [
  // POSIX essentials
  'PATH',
  'HOME',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'CI',
  // Windows essentials — without these the cmd.exe shell-spawn used for
  // `shell: true` cannot resolve %USERPROFILE%, npm/pnpm shims fail to
  // probe %PATHEXT%, and Node's child_process can't find the system
  // executable layout. None of these are secret carriers.
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'NUMBER_OF_PROCESSORS',
  'COLOR',
  'NO_COLOR',
  'FORCE_COLOR',
];

export function buildAgentEnv(
  parentEnv: NodeJS.ProcessEnv,
  passthrough: readonly string[],
): NodeJS.ProcessEnv {
  const allowed = new Set<string>([...DEFAULT_AGENT_ENV_ALLOWLIST, ...passthrough]);
  const out: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = parentEnv[name];
    if (typeof value === 'string') out[name] = value;
  }
  return out;
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
      let terminationReason: 'timeout' | 'output_limit' | null = null;

      const detached = process.platform !== 'win32';
      const env = buildAgentEnv(process.env, this.def.envPassthrough);
      const child = spawn(command, args, {
        cwd: input.worktree,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached,
        env,
      });

      // Register the child with the owner's SIGTERM handler so an owner-side
      // abort kills the agent process tree before the owner exits, preventing
      // orphaned grandchildren from continuing to write to the worktree.
      const untrackChild = child.pid ? trackActiveChild({ pid: child.pid, detached }) : () => {};

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
