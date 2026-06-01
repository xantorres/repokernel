import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AgentDefinition, AgentSentinelOutputSchema, RepoKernelError } from '@repokernel/core';
import { appendAgentLog } from '../lifecycle/runLogs.js';
import { extractSentinelPayload, MAX_PROCESS_OUTPUT_BYTES } from '../lifecycle/sentinel.js';
import {
  assertAgentTrusted,
  SIGTERM_GRACE_MS,
  spawnPolicyPiped,
  terminateWithGrace,
  trustCandidatesForCwd,
} from '../security/spawnPolicy.js';
import type { AgentRunner, SprintRunInput, SprintRunResult } from './types.js';

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
  const parsed = extractSentinelPayload(stdout);
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
    const candidates = await trustCandidatesForCwd(input.control_cwd);
    const trust = await assertAgentTrusted(this.name, this.def, input.control_cwd, {
      fallbackCwd: candidates[1],
    });
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
      const detached = process.platform !== 'win32';
      let grace: ReturnType<typeof terminateWithGrace> | null = null;

      const terminate = (reason: 'timeout' | 'output_limit') => {
        if (terminationReason) return;
        terminationReason = reason;
        if (child.pid) grace = terminateWithGrace({ pid: child.pid, detached }, SIGTERM_GRACE_MS);
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
        grace?.cancel();
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
        grace?.cancel();
        clearTimeout(timer);
        reject(new Error(`failed to spawn agent: ${err.message}`));
      });
    });
  }
}

export { parseSentinelResult, substituteArgs, validatePlaceholders };
