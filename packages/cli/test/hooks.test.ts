import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_HOOKS = resolve(__dirname, '..', 'plugin', 'hooks');
const PRE_TOOL_USE = join(PLUGIN_HOOKS, 'pre-tool-use.sh');
const SESSION_START = join(PLUGIN_HOOKS, 'session-start.sh');
const POST_TOOL_USE = join(PLUGIN_HOOKS, 'post-tool-use.sh');

interface HookResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runHook(scriptPath: string, input: unknown): Promise<HookResult> {
  return new Promise((resolveResult, rejectResult) => {
    const proc = spawn('bash', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: process.env.PATH ?? '' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', rejectResult);
    proc.on('close', (exitCode) => {
      resolveResult({ exitCode: exitCode ?? -1, stdout, stderr });
    });
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

describe('PreToolUse hook (state protection)', () => {
  it('denies Edit on .repokernel/registry.json with a routing message', async () => {
    const r = await runHook(PRE_TOOL_USE, {
      tool_name: 'Edit',
      tool_input: { file_path: '/x/.repokernel/registry.json' },
      cwd: '/x',
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('rk registry');
    expect(out.systemMessage).toContain('refused to write');
  });

  it('denies Write on a sprint frontmatter file', async () => {
    const r = await runHook(PRE_TOOL_USE, {
      tool_name: 'Write',
      tool_input: { file_path: '/x/.repokernel/plan/sprints/S-001.md' },
      cwd: '/x',
    });
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/rk start|review|close/);
  });

  it('denies edits inside .repokernel/runs/ (immutable run logs)', async () => {
    const r = await runHook(PRE_TOOL_USE, {
      tool_name: 'Edit',
      tool_input: { file_path: '/x/.repokernel/runs/RUN-001/output.json' },
      cwd: '/x',
    });
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/Run logs|rk run inspect/);
  });

  it('allows Edit on regular source files', async () => {
    const r = await runHook(PRE_TOOL_USE, {
      tool_name: 'Edit',
      tool_input: { file_path: '/x/src/foo.ts' },
      cwd: '/x',
    });
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('allows non-write tools (Bash, Read)', async () => {
    const r = await runHook(PRE_TOOL_USE, {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      cwd: '/x',
    });
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('allows when file_path is missing', async () => {
    const r = await runHook(PRE_TOOL_USE, {
      tool_name: 'Edit',
      tool_input: {},
      cwd: '/x',
    });
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
  });
});

describe('SessionStart hook (cold-start dashboard)', () => {
  it('exits silently on a non-RK cwd (no repokernel.config.yaml reachable)', async () => {
    const r = await runHook(SESSION_START, { cwd: '/tmp' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });
});

describe('PostToolUse hook (close → next suggestion)', () => {
  it('exits silently on a non-Bash tool', async () => {
    const r = await runHook(POST_TOOL_USE, {
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/foo' },
      cwd: '/tmp',
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('exits silently on a Bash command that is not rk close', async () => {
    const r = await runHook(POST_TOOL_USE, {
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
      cwd: '/tmp',
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('exits silently on `rk close --help` (false positive guard)', async () => {
    const r = await runHook(POST_TOOL_USE, {
      tool_name: 'Bash',
      tool_input: { command: 'rk close --help' },
      cwd: '/tmp',
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('exits silently on `rk close` outside an RK repo (rk fails or no project)', async () => {
    // /tmp won't have a repokernel.config.yaml, so `rk next --json` fails and
    // the hook stays silent.
    const r = await runHook(POST_TOOL_USE, {
      tool_name: 'Bash',
      tool_input: { command: 'rk close S-001' },
      cwd: '/tmp',
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });
});
