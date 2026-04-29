import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  it('denies MultiEdit when any edit targets .repokernel state', async () => {
    const r = await runHook(PRE_TOOL_USE, {
      tool_name: 'MultiEdit',
      tool_input: {
        edits: [
          { file_path: '/x/src/foo.ts', old_string: 'a', new_string: 'b' },
          {
            file_path: '/x/.repokernel/plan/sprints/S-001.md',
            old_string: 'status: active',
            new_string: 'status: shipped',
          },
        ],
      },
      cwd: '/x',
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/rk start|review|close/);
  });

  it('allows MultiEdit when no edit targets .repokernel state', async () => {
    const r = await runHook(PRE_TOOL_USE, {
      tool_name: 'MultiEdit',
      tool_input: {
        edits: [
          { file_path: '/x/src/foo.ts', old_string: 'a', new_string: 'b' },
          { file_path: '/x/src/bar.ts', old_string: 'x', new_string: 'y' },
        ],
      },
      cwd: '/x',
    });
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
  });
});

describe('SessionStart hook (cold-start dashboard)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'rk-hook-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('exits silently on a non-RK cwd (no repokernel.config.yaml reachable)', async () => {
    const r = await runHook(SESSION_START, { cwd: '/tmp' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('injects additionalContext when config found and rk returns a valid brief', async () => {
    await writeFile(join(tmpDir, 'repokernel.config.yaml'), 'projectId: test-proj\n');
    const fakeRk = join(tmpDir, 'rk');
    await writeFile(
      fakeRk,
      [
        '#!/usr/bin/env bash',
        'echo \'{"initialized":true,"project_id":"test-proj","active_epic":"E-001","next_sprint":"S-002","next_lane":"main","lanes_free":2,"lanes_total":4}\'',
      ].join('\n'),
      { mode: 0o755 },
    );
    const r = await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
      (res, rej) => {
        const proc = spawn('bash', [SESSION_START], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PATH: `${tmpDir}:${process.env.PATH ?? ''}` },
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (c: Buffer) => {
          stdout += c.toString();
        });
        proc.stderr.on('data', (c: Buffer) => {
          stderr += c.toString();
        });
        proc.on('error', rej);
        proc.on('close', (code) => {
          res({ exitCode: code ?? -1, stdout, stderr });
        });
        proc.stdin.write(JSON.stringify({ cwd: tmpDir }));
        proc.stdin.end();
      },
    );
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('RK |');
    expect(out.hookSpecificOutput.additionalContext).toContain('E-001');
    expect(out.hookSpecificOutput.additionalContext).toContain('S-002');
    expect(out.hookSpecificOutput.additionalContext).toContain('2/4');
  });

  it('exits silently when config found but rk is not on PATH', async () => {
    await writeFile(join(tmpDir, 'repokernel.config.yaml'), 'projectId: test-proj\n');
    const r = await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
      (res, rej) => {
        const proc = spawn('bash', [SESSION_START], {
          stdio: ['pipe', 'pipe', 'pipe'],
          // /usr/bin:/bin has bash + jq but not rk
          env: { ...process.env, PATH: '/usr/bin:/bin' },
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (c: Buffer) => {
          stdout += c.toString();
        });
        proc.stderr.on('data', (c: Buffer) => {
          stderr += c.toString();
        });
        proc.on('error', rej);
        proc.on('close', (code) => {
          res({ exitCode: code ?? -1, stdout, stderr });
        });
        proc.stdin.write(JSON.stringify({ cwd: tmpDir }));
        proc.stdin.end();
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('exits silently when rk status fails (non-zero exit)', async () => {
    await writeFile(join(tmpDir, 'repokernel.config.yaml'), 'projectId: test-proj\n');
    const fakeRk = join(tmpDir, 'rk');
    await writeFile(fakeRk, '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
    const r = await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
      (res, rej) => {
        const proc = spawn('bash', [SESSION_START], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PATH: `${tmpDir}:${process.env.PATH ?? ''}` },
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (c: Buffer) => {
          stdout += c.toString();
        });
        proc.stderr.on('data', (c: Buffer) => {
          stderr += c.toString();
        });
        proc.on('error', rej);
        proc.on('close', (code) => {
          res({ exitCode: code ?? -1, stdout, stderr });
        });
        proc.stdin.write(JSON.stringify({ cwd: tmpDir }));
        proc.stdin.end();
      },
    );
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
