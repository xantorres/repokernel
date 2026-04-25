import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { appendAgentLog } from '../lifecycle/runLogs.js';
import type { AgentRunner, SprintRunInput, SprintRunResult } from './types.js';

const RESULT_START = 'REPOKERNEL_RESULT_START';
const RESULT_END = 'REPOKERNEL_RESULT_END';

function extractResult(output: string): SprintRunResult | null {
  const startIdx = output.indexOf(RESULT_START);
  const endIdx = output.indexOf(RESULT_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;

  const raw = output.slice(startIdx + RESULT_START.length, endIdx).trim();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const status = parsed.status;
    if (status !== 'completed' && status !== 'blocked' && status !== 'failed') return null;

    const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
    const changed_files = Array.isArray(parsed.changed_files)
      ? (parsed.changed_files as unknown[]).filter((f): f is string => typeof f === 'string')
      : [];
    const needs_human = parsed.needs_human === true;

    return { status, summary, changed_files, needs_human };
  } catch {
    return null;
  }
}

function failResult(summary: string): SprintRunResult {
  return { status: 'failed', summary, changed_files: [], needs_human: false };
}

export class ClaudeRunner implements AgentRunner {
  readonly name = 'claude';

  async runSprint(input: SprintRunInput): Promise<SprintRunResult> {
    let packet: string;
    try {
      packet = await readFile(input.sprint_packet_path, 'utf8');
    } catch {
      return failResult(`could not read sprint packet: ${input.sprint_packet_path}`);
    }

    const args = ['--print', '--cwd', input.worktree, '-p', packet];
    let stdout = '';
    let stderr = '';
    const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const child = spawn('claude', args, {
        cwd: input.worktree,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        void appendAgentLog(
          input.run_id,
          input.sprint_id,
          `[timeout] killing claude after ${TIMEOUT_MS / 60000}m`,
          input.op_root,
        );
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
        done();
      }, TIMEOUT_MS);

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stdout += text;
        for (const line of text.split('\n')) {
          if (line) {
            void appendAgentLog(input.run_id, input.sprint_id, line, input.op_root);
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stderr += text;
        for (const line of text.split('\n')) {
          if (line) {
            void appendAgentLog(input.run_id, input.sprint_id, `[stderr] ${line}`, input.op_root);
          }
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        stderr += err.message;
        void appendAgentLog(
          input.run_id,
          input.sprint_id,
          `[spawn error] ${err.message}`,
          input.op_root,
        );
        // 'close' may not fire after 'error' on all platforms — resolve here directly.
        done();
      });

      child.on('close', () => {
        clearTimeout(timer);
        done();
      });
    });

    const combined = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
    const result = extractResult(combined) ?? extractResult(stdout);

    if (!result) {
      const preview = stdout.slice(0, 200).replace(/\n/g, '↵');
      return failResult(
        `no valid REPOKERNEL_RESULT block found in agent output (preview: ${preview})`,
      );
    }

    return result;
  }
}
