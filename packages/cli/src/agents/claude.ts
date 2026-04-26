import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { appendAgentLog } from '../lifecycle/runLogs.js';
import { parseSentinelResult } from './external.js';
import type { AgentRunner, SprintRunInput, SprintRunResult } from './types.js';

const TIMEOUT_MS = 30 * 60 * 1000;

function failResult(summary: string): SprintRunResult {
  return { status: 'failed', summary, changed_files: [], needs_human: false };
}

async function spawnWithLogs(
  command: string,
  args: string[],
  input: SprintRunInput,
): Promise<{ stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const child = spawn(command, args, {
      cwd: input.worktree,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      void appendAgentLog(
        input.run_id,
        input.sprint_id,
        `[timeout] killing ${command} after ${TIMEOUT_MS / 60000}m`,
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
        if (line) void appendAgentLog(input.run_id, input.sprint_id, line, input.op_root);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      for (const line of text.split('\n')) {
        if (line)
          void appendAgentLog(input.run_id, input.sprint_id, `[stderr] ${line}`, input.op_root);
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
      done();
    });

    child.on('close', () => {
      clearTimeout(timer);
      done();
    });
  });

  return { stdout, stderr };
}

type SpawnFn = typeof spawnWithLogs;

export class ClaudeRunner implements AgentRunner {
  readonly name = 'claude';
  private readonly spawnFn: SpawnFn;

  constructor(spawnFn: SpawnFn = spawnWithLogs) {
    this.spawnFn = spawnFn;
  }

  async runSprint(input: SprintRunInput): Promise<SprintRunResult> {
    let packet: string;
    try {
      packet = await readFile(input.sprint_packet_path, 'utf8');
    } catch {
      return failResult(`could not read sprint packet: ${input.sprint_packet_path}`);
    }

    const { stdout } = await this.spawnFn(
      'claude',
      ['--print', '--cwd', input.worktree, '-p', packet],
      input,
    );

    try {
      return parseSentinelResult(stdout);
    } catch {
      const preview = stdout.slice(0, 200).replace(/\n/g, '↵');
      return failResult(
        `no valid REPOKERNEL_RESULT block found in agent output (preview: ${preview})`,
      );
    }
  }
}

export class CodexRunner implements AgentRunner {
  readonly name = 'codex';
  private readonly spawnFn: SpawnFn;

  constructor(spawnFn: SpawnFn = spawnWithLogs) {
    this.spawnFn = spawnFn;
  }

  async runSprint(input: SprintRunInput): Promise<SprintRunResult> {
    let packet: string;
    try {
      packet = await readFile(input.sprint_packet_path, 'utf8');
    } catch {
      return failResult(`could not read sprint packet: ${input.sprint_packet_path}`);
    }

    const { stdout } = await this.spawnFn(
      'codex',
      ['--approval-mode', 'full-auto', '-q', packet],
      input,
    );

    try {
      return parseSentinelResult(stdout);
    } catch {
      const preview = stdout.slice(0, 200).replace(/\n/g, '↵');
      return failResult(
        `no valid REPOKERNEL_RESULT block found in agent output (preview: ${preview})`,
      );
    }
  }
}

export { spawnWithLogs };
