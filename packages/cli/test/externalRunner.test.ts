/**
 * Unit tests for ExternalRunner — sentinel parsing, arg substitution, error cases.
 * No real processes spawned (happy path uses a tiny inline script via node -e).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition } from '@repokernel/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runId } from './helpers/brand.js';

vi.mock('../src/lifecycle/runLogs.js', () => ({
  appendAgentLog: vi.fn().mockResolvedValue(undefined),
  appendLifecycleLog: vi.fn().mockResolvedValue(undefined),
  appendLog: vi.fn().mockResolvedValue(undefined),
}));

import { ExternalRunner, parseSentinelResult, substituteArgs } from '../src/agents/external.js';
import type { SprintRunInput } from '../src/agents/types.js';
import { resetTrustForTest, seedTrustForCwd } from './helpers/fixture.js';

// — substituteArgs —

describe('substituteArgs', () => {
  const input: SprintRunInput = {
    run_id: runId('RUN-001'),
    epic_id: 'E-001' as `E-${string}`,
    sprint_id: 'S-001' as `S-${string}`,
    worktree: '/tmp/wt',
    control_cwd: '/tmp/repo',
    op_root: '/tmp/.git/repokernel',
    sprint_packet_path: '/tmp/wt/packet.md',
    registry_path: '/tmp/wt/.repokernel/registry.json',
    mode: 'assisted',
  };

  it('substitutes all placeholders', () => {
    const args = [
      '{packet_path}',
      '{worktree}',
      '{sprint_id}',
      '{run_id}',
      '{epic_id}',
      '{op_root}',
      '{registry_path}',
      '{mode}',
    ];
    const result = substituteArgs(args, input);
    expect(result).toEqual([
      '/tmp/wt/packet.md',
      '/tmp/wt',
      'S-001',
      'RUN-001',
      'E-001',
      '/tmp/.git/repokernel',
      '/tmp/wt/.repokernel/registry.json',
      'assisted',
    ]);
  });

  it('leaves args without placeholders unchanged', () => {
    expect(substituteArgs(['--verbose', '--no-color'], input)).toEqual(['--verbose', '--no-color']);
  });

  it('substitutes multiple occurrences in one arg', () => {
    const result = substituteArgs(['{sprint_id}-{run_id}'], input);
    expect(result).toEqual(['S-001-RUN-001']);
  });
});

// — parseSentinelResult —

describe('parseSentinelResult', () => {
  function wrap(json: string): string {
    return `some preamble\nREPOKERNEL_RESULT_START\n${json}\nREPOKERNEL_RESULT_END\ntrailing`;
  }

  it('parses a valid completed result', () => {
    const result = parseSentinelResult(
      wrap(
        JSON.stringify({
          status: 'completed',
          summary: 'done',
          changed_files: ['foo.ts'],
          needs_human: false,
        }),
      ),
    );
    expect(result.status).toBe('completed');
    expect(result.summary).toBe('done');
    expect(result.changed_files).toEqual(['foo.ts']);
    expect(result.needs_human).toBe(false);
  });

  it('parses blocked and failed statuses', () => {
    for (const status of ['blocked', 'failed'] as const) {
      const result = parseSentinelResult(
        wrap(JSON.stringify({ status, summary: 'x', changed_files: [] })),
      );
      expect(result.status).toBe(status);
    }
  });

  it('defaults changed_files to [] when missing', () => {
    const result = parseSentinelResult(
      wrap(JSON.stringify({ status: 'completed', summary: 'ok' })),
    );
    expect(result.changed_files).toEqual([]);
  });

  it('throws when sentinel markers missing', () => {
    expect(() => parseSentinelResult('no markers here')).toThrow('missing sentinel markers');
  });

  it('throws on invalid JSON between sentinels', () => {
    expect(() =>
      parseSentinelResult('REPOKERNEL_RESULT_START\nnot-json\nREPOKERNEL_RESULT_END'),
    ).toThrow('not valid JSON');
  });

  it('throws on invalid status value', () => {
    expect(() =>
      parseSentinelResult(
        wrap(JSON.stringify({ status: 'unknown', summary: 'x', changed_files: [] })),
      ),
    ).toThrow(/schema validation|Invalid enum value/);
  });

  it('throws when required fields missing', () => {
    expect(() => parseSentinelResult(wrap(JSON.stringify({ status: 'completed' })))).toThrow(
      /schema validation|Required|summary/,
    );
  });
});

// — ExternalRunner integration (real process) —

describe('ExternalRunner', () => {
  let tmpDir: string;
  let originalTrustEnv: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'rk-ext-'));
    originalTrustEnv = process.env.REPOKERNEL_TRUST_FILE;
    // Every test in this suite uses the same agent name 'test-agent'.
    await seedTrustForCwd(tmpDir, { agents: ['test-agent'] });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    resetTrustForTest(originalTrustEnv);
  });

  function makeInput(): SprintRunInput {
    return {
      run_id: runId('RUN-001'),
      epic_id: 'E-001' as `E-${string}`,
      sprint_id: 'S-001' as `S-${string}`,
      worktree: tmpDir,
      control_cwd: tmpDir,
      op_root: join(tmpDir, 'op'),
      sprint_packet_path: join(tmpDir, 'packet.md'),
      registry_path: join(tmpDir, 'registry.json'),
      mode: 'assisted',
    };
  }

  function makeDef(script: string, timeoutSeconds = 10): AgentDefinition {
    return {
      command: 'node',
      args: ['-e', script],
      resultFormat: 'sentinel-json',
      timeoutSeconds,
      envPassthrough: [],
    };
  }

  it('runs a command and parses sentinel result', async () => {
    const script = `
      const result = { status: 'completed', summary: 'all good', changed_files: ['x.ts'], needs_human: false };
      process.stdout.write('REPOKERNEL_RESULT_START\\n' + JSON.stringify(result) + '\\nREPOKERNEL_RESULT_END\\n');
    `;
    const runner = new ExternalRunner('test-agent', makeDef(script));
    const result = await runner.runSprint(makeInput());
    expect(result.status).toBe('completed');
    expect(result.summary).toBe('all good');
    expect(result.changed_files).toEqual(['x.ts']);
  });

  it('rejects when process exits non-zero', async () => {
    const runner = new ExternalRunner('test-agent', makeDef('process.exit(1)'));
    await expect(runner.runSprint(makeInput())).rejects.toThrow('code 1');
  });

  it('rejects when sentinel markers are absent', async () => {
    const runner = new ExternalRunner('test-agent', makeDef('process.stdout.write("no markers")'));
    await expect(runner.runSprint(makeInput())).rejects.toThrow('missing sentinel markers');
  });

  it('rejects on timeout', async () => {
    const script = `setTimeout(() => {}, 60000)`;
    const def = makeDef(script, 1);
    const runner = new ExternalRunner('test-agent', def);
    await expect(runner.runSprint(makeInput())).rejects.toThrow('timed out after 1s');
  }, 5000);

  it('rejects when agent output exceeds 10 MB limit', async () => {
    // 11 MB > MAX_PROCESS_OUTPUT_BYTES (10 MB)
    const script = `process.stdout.write('x'.repeat(11 * 1024 * 1024))`;
    const runner = new ExternalRunner('test-agent', makeDef(script));
    await expect(runner.runSprint(makeInput())).rejects.toThrow('output exceeded');
  }, 15_000);

  it.runIf(process.platform !== 'win32')(
    'kills grandchild process tree on timeout (orphan reaping)',
    async () => {
      const pidFile = join(tmpDir, 'grandchild.pid');
      const script = `
        const { spawn } = require('child_process');
        const fs = require('fs');
        const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore',
        });
        fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
        setInterval(() => {}, 1000);
      `;
      const runner = new ExternalRunner('test-agent', makeDef(script, 1));
      await expect(runner.runSprint(makeInput())).rejects.toThrow('timed out');

      const { readFile } = await import('node:fs/promises');
      const pidStr = await readFile(pidFile, 'utf8');
      const grandchildPid = Number(pidStr.trim());
      expect(grandchildPid).toBeGreaterThan(0);

      // Poll for grandchild death. ExternalRunner sends SIGTERM, then SIGKILL
      // after a 5s grace window — give us up to 12s before failing.
      let alive = true;
      for (let i = 0; i < 60; i++) {
        try {
          process.kill(grandchildPid, 0);
          await new Promise((r) => setTimeout(r, 200));
        } catch {
          alive = false;
          break;
        }
      }
      expect(alive).toBe(false);
    },
    20_000,
  );

  it('substitutes sprint_id placeholder in args', async () => {
    // Use process.argv.at(-1) — last arg regardless of argv[1] behavior in -e mode
    const script = `
      const id = process.argv.at(-1);
      const result = { status: 'completed', summary: 'id=' + id, changed_files: [] };
      process.stdout.write('REPOKERNEL_RESULT_START\\n' + JSON.stringify(result) + '\\nREPOKERNEL_RESULT_END\\n');
    `;
    const def: AgentDefinition = {
      command: 'node',
      args: ['-e', script, '{sprint_id}'],
      resultFormat: 'sentinel-json',
      timeoutSeconds: 10,
      envPassthrough: [],
    };
    const runner = new ExternalRunner('test-agent', def);
    const result = await runner.runSprint(makeInput());
    expect(result.summary).toBe('id=S-001');
  });
});
