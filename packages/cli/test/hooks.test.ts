import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_HOOKS = resolve(__dirname, '..', 'plugin', 'hooks');
const PRE_TOOL_USE = join(PLUGIN_HOOKS, 'pre-tool-use.sh');
const SESSION_START = join(PLUGIN_HOOKS, 'session-start.sh');
const POST_TOOL_USE = join(PLUGIN_HOOKS, 'post-tool-use.sh');
const DIST = resolve(__dirname, '..', 'dist', 'index.js');

interface HookResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runHook(
  scriptPath: string,
  input: unknown,
  pathOverride?: string,
): Promise<HookResult> {
  return new Promise((resolveResult, rejectResult) => {
    const proc = spawn('bash', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: pathOverride ?? process.env.PATH ?? '' },
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

const DEFAULT_FIXTURE_CONFIG = `schemaVersion: 1
projectId: hooks-test
projectName: Hooks Test
paths:
  epics: .repokernel/plan/epics
  sprints: .repokernel/plan/sprints
  reviews: .repokernel/plan/reviews
  queues: .repokernel/plan/queues
  lanes: .repokernel/plan/lanes
  generated: .repokernel
  registry: .repokernel/registry.json
`;

async function makeRkProject(configYaml: string = DEFAULT_FIXTURE_CONFIG): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-hooks-'));
  await writeFile(join(dir, 'repokernel.config.yaml'), configYaml);
  return dir;
}

describe('PreToolUse hook (state protection)', () => {
  // Wrapper bin dir injected on PATH so the hook can find `rk`. Created once;
  // points at the repo's built dist/index.js. Tests that need an alternate
  // `rk` (or no rk) override PATH per-invocation. Real RK fixtures live
  // alongside (default layout + custom --dir layout) and are reused.
  let binDir: string;
  let pathWithRk: string;
  let defaultProj: string;
  let customDirProj: string;

  beforeAll(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'rk-hooks-bin-'));
    const wrapper = join(binDir, 'rk');
    await writeFile(wrapper, `#!/usr/bin/env bash\nexec node ${JSON.stringify(DIST)} "$@"\n`, {
      mode: 0o755,
    });
    pathWithRk = `${binDir}:${process.env.PATH ?? ''}`;

    defaultProj = await makeRkProject();
    customDirProj = await makeRkProject(`schemaVersion: 1
projectId: custom-test
projectName: Custom Test
paths:
  epics: rk/plan/epics
  sprints: rk/plan/sprints
  reviews: rk/plan/reviews
  queues: rk/plan/queues
  lanes: rk/plan/lanes
  generated: rk
  registry: rk/registry.json
`);
  });

  afterAll(async () => {
    await rm(binDir, { recursive: true, force: true });
    await rm(defaultProj, { recursive: true, force: true });
    await rm(customDirProj, { recursive: true, force: true });
  });

  it('denies Edit on .repokernel/registry.json with a routing message', async () => {
    const r = await runHook(
      PRE_TOOL_USE,
      {
        tool_name: 'Edit',
        tool_input: { file_path: join(defaultProj, '.repokernel/registry.json') },
        cwd: defaultProj,
      },
      pathWithRk,
    );
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('rk registry');
    expect(out.systemMessage).toContain('refused to write');
  });

  it('denies Write on a sprint frontmatter file', async () => {
    const r = await runHook(
      PRE_TOOL_USE,
      {
        tool_name: 'Write',
        tool_input: { file_path: join(defaultProj, '.repokernel/plan/sprints/S-001.md') },
        cwd: defaultProj,
      },
      pathWithRk,
    );
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/rk start|review|close/);
  });

  it('denies edits inside .repokernel/runs/ (immutable run logs)', async () => {
    const r = await runHook(
      PRE_TOOL_USE,
      {
        tool_name: 'Edit',
        tool_input: { file_path: join(defaultProj, '.repokernel/runs/RUN-001/output.json') },
        cwd: defaultProj,
      },
      pathWithRk,
    );
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/Run logs|rk run inspect/);
  });

  it('denies sprint edit under a custom --dir layout', async () => {
    const r = await runHook(
      PRE_TOOL_USE,
      {
        tool_name: 'Write',
        tool_input: { file_path: join(customDirProj, 'rk/plan/sprints/S-001.md') },
        cwd: customDirProj,
      },
      pathWithRk,
    );
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/rk start|review|close/);
  });

  it('allows .repokernel-shaped path under a custom --dir project (no leak)', async () => {
    const r = await runHook(
      PRE_TOOL_USE,
      {
        tool_name: 'Write',
        tool_input: { file_path: join(customDirProj, '.repokernel/registry.json') },
        cwd: customDirProj,
      },
      pathWithRk,
    );
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('allows Edit on regular source files', async () => {
    const r = await runHook(
      PRE_TOOL_USE,
      {
        tool_name: 'Edit',
        tool_input: { file_path: join(defaultProj, 'src/foo.ts') },
        cwd: defaultProj,
      },
      pathWithRk,
    );
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('allows non-write tools (Bash, Read)', async () => {
    const r = await runHook(
      PRE_TOOL_USE,
      {
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        cwd: defaultProj,
      },
      pathWithRk,
    );
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('allows when file_path is missing', async () => {
    const r = await runHook(
      PRE_TOOL_USE,
      {
        tool_name: 'Edit',
        tool_input: {},
        cwd: defaultProj,
      },
      pathWithRk,
    );
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('denies MultiEdit when any edit targets .repokernel state', async () => {
    // State file appears second; the hook must still catch it.
    const r = await runHook(
      PRE_TOOL_USE,
      {
        tool_name: 'MultiEdit',
        tool_input: {
          edits: [
            { file_path: join(defaultProj, 'src/foo.ts'), old_string: 'a', new_string: 'b' },
            {
              file_path: join(defaultProj, '.repokernel/plan/sprints/S-001.md'),
              old_string: 'status: active',
              new_string: 'status: shipped',
            },
          ],
        },
        cwd: defaultProj,
      },
      pathWithRk,
    );
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/rk start|review|close/);
  });

  it('allows MultiEdit when no edit targets .repokernel state', async () => {
    const r = await runHook(
      PRE_TOOL_USE,
      {
        tool_name: 'MultiEdit',
        tool_input: {
          edits: [
            { file_path: join(defaultProj, 'src/foo.ts'), old_string: 'a', new_string: 'b' },
            { file_path: join(defaultProj, 'src/bar.ts'), old_string: 'x', new_string: 'y' },
          ],
        },
        cwd: defaultProj,
      },
      pathWithRk,
    );
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('fails open (allow) when rk is not on PATH', async () => {
    const r = await runHook(
      PRE_TOOL_USE,
      {
        tool_name: 'Edit',
        tool_input: { file_path: join(defaultProj, '.repokernel/registry.json') },
        cwd: defaultProj,
      },
      '/usr/bin:/bin',
    );
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
