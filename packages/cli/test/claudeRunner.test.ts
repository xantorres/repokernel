import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeRunner, CodexRunner } from '../src/agents/claude.js';
import type { SprintRunInput } from '../src/agents/types.js';

// ---- helpers ----

function sentinel(json: Record<string, unknown>): string {
  return `REPOKERNEL_RESULT_START\n${JSON.stringify(json)}\nREPOKERNEL_RESULT_END\n`;
}

function makeSpawn(stdout: string, stderr = '') {
  return vi.fn().mockResolvedValue({ stdout, stderr });
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'rk-claude-'));
  await mkdir(join(tmpDir, 'op', 'logs'), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeInput(overrides: Partial<SprintRunInput> = {}): SprintRunInput {
  return {
    run_id: 'RUN-001' as `RUN-${string}`,
    epic_id: 'E-001' as `E-${string}`,
    sprint_id: 'S-001' as `S-${string}`,
    worktree: tmpDir,
    control_cwd: tmpDir,
    op_root: join(tmpDir, 'op'),
    sprint_packet_path: join(tmpDir, 'packet.md'),
    registry_path: join(tmpDir, 'registry.json'),
    mode: 'assisted',
    ...overrides,
  };
}

async function writePacket(content = '# Sprint packet') {
  await writeFile(join(tmpDir, 'packet.md'), content, 'utf8');
}

// ---- ClaudeRunner ----

describe('ClaudeRunner', () => {
  describe('happy path', () => {
    it('returns completed result from sentinel output', async () => {
      await writePacket();
      const spawnFn = makeSpawn(
        sentinel({
          status: 'completed',
          summary: 'all done',
          changed_files: ['foo.ts'],
          needs_human: false,
        }),
      );
      const runner = new ClaudeRunner(spawnFn);
      const result = await runner.runSprint(makeInput());

      expect(result.status).toBe('completed');
      expect(result.summary).toBe('all done');
      expect(result.changed_files).toEqual(['foo.ts']);
      expect(result.needs_human).toBe(false);
    });

    it('passes packet content as last arg to claude', async () => {
      const packetContent = '# My sprint packet';
      await writePacket(packetContent);
      const spawnFn = makeSpawn(
        sentinel({ status: 'completed', summary: 'ok', changed_files: [] }),
      );
      const runner = new ClaudeRunner(spawnFn);
      await runner.runSprint(makeInput());

      expect(spawnFn).toHaveBeenCalledOnce();
      const [cmd, args] = spawnFn.mock.calls[0] as [string, string[], SprintRunInput];
      expect(cmd).toBe('claude');
      expect(args).toContain('--print');
      expect(args.at(-1)).toBe(packetContent);
    });

    it('passes input as third arg to spawnFn', async () => {
      await writePacket();
      const spawnFn = makeSpawn(
        sentinel({ status: 'completed', summary: 'ok', changed_files: [] }),
      );
      const runner = new ClaudeRunner(spawnFn);
      const input = makeInput();
      await runner.runSprint(input);

      const [, , passedInput] = spawnFn.mock.calls[0] as [string, string[], SprintRunInput];
      expect(passedInput).toBe(input);
    });

    it('returns blocked result', async () => {
      await writePacket();
      const spawnFn = makeSpawn(
        sentinel({ status: 'blocked', summary: 'need help', changed_files: [] }),
      );
      const runner = new ClaudeRunner(spawnFn);
      const result = await runner.runSprint(makeInput());
      expect(result.status).toBe('blocked');
    });
  });

  describe('review field passthrough', () => {
    it('passes review field through when present in sentinel', async () => {
      await writePacket();
      const spawnFn = makeSpawn(
        sentinel({
          status: 'completed',
          summary: 'done',
          changed_files: [],
          review: {
            verdict: 'accepted',
            findings: [{ severity: 'info', message: 'looks good' }],
          },
        }),
      );
      const runner = new ClaudeRunner(spawnFn);
      const result = await runner.runSprint(makeInput({ mode: 'autonomous' }));

      expect(result.review).toBeDefined();
      expect(result.review?.verdict).toBe('accepted');
      expect(result.review?.findings).toHaveLength(1);
      expect(result.review?.findings[0]).toEqual({ severity: 'info', message: 'looks good' });
    });

    it('review is undefined when sentinel omits it', async () => {
      await writePacket();
      const spawnFn = makeSpawn(
        sentinel({ status: 'completed', summary: 'done', changed_files: [] }),
      );
      const runner = new ClaudeRunner(spawnFn);
      const result = await runner.runSprint(makeInput({ mode: 'autonomous' }));
      expect(result.review).toBeUndefined();
    });

    it('passes review with changes_requested verdict', async () => {
      await writePacket();
      const spawnFn = makeSpawn(
        sentinel({
          status: 'completed',
          summary: 'needs work',
          changed_files: [],
          review: { verdict: 'changes_requested', findings: [] },
        }),
      );
      const runner = new ClaudeRunner(spawnFn);
      const result = await runner.runSprint(makeInput({ mode: 'autonomous' }));
      expect(result.review?.verdict).toBe('changes_requested');
    });

    it('ignores review with invalid verdict', async () => {
      await writePacket();
      const spawnFn = makeSpawn(
        sentinel({
          status: 'completed',
          summary: 'done',
          changed_files: [],
          review: { verdict: 'unknown_verdict', findings: [] },
        }),
      );
      const runner = new ClaudeRunner(spawnFn);
      const result = await runner.runSprint(makeInput({ mode: 'autonomous' }));
      expect(result.review).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('returns failResult when packet file is missing', async () => {
      // no writePacket() call — file does not exist
      const spawnFn = makeSpawn('');
      const runner = new ClaudeRunner(spawnFn);
      const result = await runner.runSprint(makeInput());

      expect(result.status).toBe('failed');
      expect(result.summary).toContain('could not read sprint packet');
      expect(spawnFn).not.toHaveBeenCalled();
    });

    it('returns failResult when sentinel markers are absent', async () => {
      await writePacket();
      const spawnFn = makeSpawn('some output without markers');
      const runner = new ClaudeRunner(spawnFn);
      const result = await runner.runSprint(makeInput());

      expect(result.status).toBe('failed');
      expect(result.summary).toContain('no valid REPOKERNEL_RESULT block');
    });

    it('returns failResult when sentinel JSON is malformed', async () => {
      await writePacket();
      const spawnFn = makeSpawn(
        'REPOKERNEL_RESULT_START\nnot-json-at-all\nREPOKERNEL_RESULT_END\n',
      );
      const runner = new ClaudeRunner(spawnFn);
      const result = await runner.runSprint(makeInput());

      expect(result.status).toBe('failed');
      expect(result.summary).toContain('no valid REPOKERNEL_RESULT block');
    });

    it('includes stdout preview in failResult summary', async () => {
      await writePacket();
      const preview = 'some agent output that lacks sentinel';
      const spawnFn = makeSpawn(preview);
      const runner = new ClaudeRunner(spawnFn);
      const result = await runner.runSprint(makeInput());

      expect(result.summary).toContain('preview:');
    });
  });
});

// ---- CodexRunner ----

describe('CodexRunner', () => {
  it('returns completed result from sentinel output', async () => {
    await writePacket();
    const spawnFn = makeSpawn(
      sentinel({ status: 'completed', summary: 'codex done', changed_files: ['a.py'] }),
    );
    const runner = new CodexRunner(spawnFn);
    const result = await runner.runSprint(makeInput());

    expect(result.status).toBe('completed');
    expect(result.summary).toBe('codex done');
    expect(result.changed_files).toEqual(['a.py']);
  });

  it('passes approval-mode flag and packet content', async () => {
    const packetContent = '# codex packet';
    await writePacket(packetContent);
    const spawnFn = makeSpawn(sentinel({ status: 'completed', summary: 'ok', changed_files: [] }));
    const runner = new CodexRunner(spawnFn);
    await runner.runSprint(makeInput());

    const [cmd, args] = spawnFn.mock.calls[0] as [string, string[], SprintRunInput];
    expect(cmd).toBe('codex');
    expect(args).toContain('--approval-mode');
    expect(args).toContain('full-auto');
    expect(args.at(-1)).toBe(packetContent);
  });

  it('returns failResult when packet file is missing', async () => {
    const spawnFn = makeSpawn('');
    const runner = new CodexRunner(spawnFn);
    const result = await runner.runSprint(makeInput());

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('could not read sprint packet');
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('passes review field through when sentinel includes it', async () => {
    await writePacket();
    const spawnFn = makeSpawn(
      sentinel({
        status: 'completed',
        summary: 'done',
        changed_files: [],
        review: { verdict: 'accepted', findings: [] },
      }),
    );
    const runner = new CodexRunner(spawnFn);
    const result = await runner.runSprint(makeInput({ mode: 'autonomous' }));

    expect(result.review?.verdict).toBe('accepted');
  });
});
