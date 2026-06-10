import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCreateEpicCommand, runCreateSprintCommand } from '../src/commands/create.js';
import { runDoctorCommand } from '../src/commands/doctor.js';
import { runCloseTaskCommand } from '../src/commands/fastpath/closeTask.js';
import { runFastpathTask } from '../src/commands/fastpath/runTask.js';
import { runInitCommand } from '../src/commands/init.js';
import type { PromptIO } from '../src/commands/initPrompts.js';
import { runValidateCommand } from '../src/commands/validate.js';

const execFileAsync = promisify(execFile);

const NEVER_PROMPT_IO: PromptIO = {
  isTTY: false,
  question: async () => {
    throw new Error('prompts must not run in non-TTY tests');
  },
};

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'rk-fresh-'));
  await execFileAsync('git', ['init', '-q', cwd]);
});

afterEach(async () => {
  // maxRetries handles ENOTEMPTY from git background processes (gc/pack)
  // that are still holding files open when cleanup runs on CI filesystems.
  await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
});

describe('fresh install canary', () => {
  it('runs init --example --non-interactive then doctor without errors', async () => {
    const initResult = await runInitCommand({
      cwd,
      example: true,
      nonInteractive: true,
      agent: 'fake',
      io: NEVER_PROMPT_IO,
    });
    expect(initResult.exitCode).toBe(0);
    expect(initResult.stdout).toContain('RepoKernel initialized.');
    expect(initResult.stdout).toContain('agent:     fake');
    expect(initResult.stdout).toContain('rk next                # picks S-002');

    // Config YAML reflects the chosen agent.
    const yaml = await readFile(join(cwd, 'repokernel.config.yaml'), 'utf8');
    expect(yaml).toContain('defaultAgent: "fake"');
    expect(yaml).toContain('defaultLane: "main"');
    expect(yaml).toContain('chaining:\n  enabled: true');

    // doctor on a freshly seeded example should pass — sprints + queue exist.
    const doctorResult = await runDoctorCommand({ cwd });
    expect(doctorResult.exitCode).toBe(0);
    expect(doctorResult.stdout).toContain('RepoKernel setup looks good.');
  });

  it('doctor catches missing local registry merge-driver config', async () => {
    const initResult = await runInitCommand({
      cwd,
      example: true,
      nonInteractive: true,
      agent: 'fake',
      io: NEVER_PROMPT_IO,
    });
    expect(initResult.exitCode).toBe(0);
    await execFileAsync('git', [
      '-C',
      cwd,
      'config',
      '--unset-all',
      'merge.repokernel-registry.driver',
    ]);

    const doctorResult = await runDoctorCommand({ cwd, json: true });
    expect(doctorResult.exitCode).not.toBe(0);
    const parsed = JSON.parse(doctorResult.stdout) as {
      problems: Array<{ title: string; found?: string }>;
    };
    expect(parsed.problems.some((p) => p.title.includes('merge driver git config'))).toBe(true);
  });

  it('runs init without --example and surfaces preflight warnings via doctor', async () => {
    const initResult = await runInitCommand({
      cwd,
      example: false,
      nonInteractive: true,
      agent: 'manual',
      io: NEVER_PROMPT_IO,
    });
    expect(initResult.exitCode).toBe(0);
    expect(initResult.stdout).toContain('agent:     manual');

    // No sprints yet → doctor surfaces "No sprint files found" plus preflight.
    const doctorResult = await runDoctorCommand({ cwd });
    expect(doctorResult.exitCode).not.toBe(0);
    expect(doctorResult.stdout).toContain('No sprint files found');
  });

  it('is idempotent — running init twice does not re-create files', async () => {
    const first = await runInitCommand({
      cwd,
      example: true,
      nonInteractive: true,
      agent: 'fake',
      io: NEVER_PROMPT_IO,
    });
    const second = await runInitCommand({
      cwd,
      example: true,
      nonInteractive: true,
      agent: 'fake',
      io: NEVER_PROMPT_IO,
    });
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('Already existed:');
    expect(second.stdout).not.toContain('Created:');
  });

  it('non-example init scaffolds the default lane queue so a sprint validates clean', async () => {
    const initResult = await runInitCommand({
      cwd,
      example: false,
      nonInteractive: true,
      agent: 'manual',
      io: NEVER_PROMPT_IO,
    });
    expect(initResult.exitCode).toBe(0);
    // The default lane's queue file exists immediately after init, under the
    // configured queues path (.repokernel/plan/queues by default).
    const queueRaw = await readFile(join(cwd, '.repokernel/plan/queues/main.md'), 'utf8');
    expect(queueRaw).toContain('lane: "main"');

    // A sprint created on the default lane has a backing queue, so neither the
    // UNKNOWN_LANE nor SPRINT_LANE_HAS_NO_QUEUE finding fires.
    const epicId = (
      JSON.parse((await runCreateEpicCommand('E', { cwd, json: true })).stdout) as { id: string }
    ).id;
    const sprint = await runCreateSprintCommand('S', {
      cwd,
      epic: epicId,
      lane: 'main',
      status: 'planned',
      json: true,
    });
    expect(sprint.exitCode).toBe(0);

    const validate = await runValidateCommand({ cwd, json: true });
    const obj = JSON.parse(validate.stdout) as { findings: Array<{ code: string }> };
    const laneFindings = obj.findings.filter(
      (f) => f.code === 'UNKNOWN_LANE' || f.code === 'SPRINT_LANE_HAS_NO_QUEUE',
    );
    expect(laneFindings).toEqual([]);
  });

  it('non-example init is idempotent for the default lane queue', async () => {
    const first = await runInitCommand({
      cwd,
      example: false,
      nonInteractive: true,
      agent: 'manual',
      io: NEVER_PROMPT_IO,
    });
    expect(first.stdout).toContain('queues/main.md');
    const second = await runInitCommand({
      cwd,
      example: false,
      nonInteractive: true,
      agent: 'manual',
      io: NEVER_PROMPT_IO,
    });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('Already existed:');
    expect(second.stdout).not.toContain('Created:');
  });

  it('writes checksCmd to the config when supplied', async () => {
    const result = await runInitCommand({
      cwd,
      example: false,
      nonInteractive: true,
      agent: 'manual',
      checksCmd: 'pnpm test',
      io: NEVER_PROMPT_IO,
    });
    expect(result.exitCode).toBe(0);
    const yaml = await readFile(join(cwd, 'repokernel.config.yaml'), 'utf8');
    expect(yaml).toContain('checksCmd: "pnpm test"');
    expect(result.stdout).toContain('checks:    pnpm test');
  });

  it('can commit initialized RepoKernel metadata so fastpath can start cleanly', async () => {
    await execFileAsync('git', ['-C', cwd, 'config', 'user.email', 'test@test.test']);
    await execFileAsync('git', ['-C', cwd, 'config', 'user.name', 'test']);

    const result = await runInitCommand({
      cwd,
      example: false,
      nonInteractive: true,
      agent: 'fake',
      commit: true,
      io: NEVER_PROMPT_IO,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Committed:');
    expect(result.stdout).toContain('chore(rk): init RepoKernel');

    const { stdout: status } = await execFileAsync('git', ['-C', cwd, 'status', '--porcelain']);
    expect(status.trim()).toBe('');

    const { stdout: log } = await execFileAsync('git', ['-C', cwd, 'log', '--oneline', '-1']);
    expect(log).toContain('chore(rk): init RepoKernel');
  });

  it('runs the committed fastpath quickstart through close', async () => {
    await execFileAsync('git', ['-C', cwd, 'config', 'user.email', 'test@test.test']);
    await execFileAsync('git', ['-C', cwd, 'config', 'user.name', 'test']);
    await runInitCommand({
      cwd,
      example: false,
      nonInteractive: true,
      agent: 'fake',
      commit: true,
      io: NEVER_PROMPT_IO,
    });

    // Capture terminal writes too: the sprint/run "Next steps" block is written
    // straight to process.stdout, so a returned-stdout check alone can't prove
    // the fastpath shows a single, task-language next step.
    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      const cb = rest.find((a) => typeof a === 'function') as ((err?: Error) => void) | undefined;
      cb?.();
      return true;
    }) as typeof process.stdout.write;

    let run: Awaited<ReturnType<typeof runFastpathTask>>;
    try {
      run = await runFastpathTask({
        cwd,
        inlineMessage: 'Add a README section about RepoKernel',
        agent: 'fake',
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('Task T-001');
    expect(run.stdout).toContain('rk close T-001');

    // Exactly one next step, in task language — no competing sprint/run block.
    const terminal = writes.join('') + run.stdout;
    expect(terminal).not.toContain('Next steps:');
    expect(terminal).not.toContain('review-verdict');
    expect(terminal).not.toMatch(/--resume RUN-/);

    const close = await runCloseTaskCommand({ cwd, taskId: 'T-001' });
    expect(close.exitCode).toBe(0);
    expect(close.stdout).toContain('Closed T-001');

    const { stdout: status } = await execFileAsync('git', ['-C', cwd, 'status', '--porcelain']);
    expect(status.trim()).toBe('');
  });

  it('quotes --dir paths containing YAML-special characters', async () => {
    const result = await runInitCommand({
      cwd,
      example: false,
      nonInteractive: true,
      agent: 'manual',
      dir: 'my: rk',
      io: NEVER_PROMPT_IO,
    });
    expect(result.exitCode).toBe(0);

    const yaml = await readFile(join(cwd, 'repokernel.config.yaml'), 'utf8');
    expect(yaml).toContain('epics: "my: rk/plan/epics"');
    expect(yaml).toContain('generated: "my: rk"');

    const { loadConfig } = await import('@repokernel/core');
    const cfg = await loadConfig({ cwd });
    expect(cfg.ok).toBe(true);
  });

  it('relocates everything (plan + generated + registry) when --dir is supplied', async () => {
    const result = await runInitCommand({
      cwd,
      example: false,
      nonInteractive: true,
      agent: 'manual',
      dir: 'rk',
      io: NEVER_PROMPT_IO,
    });
    expect(result.exitCode).toBe(0);

    const yaml = await readFile(join(cwd, 'repokernel.config.yaml'), 'utf8');
    expect(yaml).toContain('epics: "rk/plan/epics"');
    expect(yaml).toContain('sprints: "rk/plan/sprints"');
    expect(yaml).toContain('reviews: "rk/plan/reviews"');
    expect(yaml).toContain('queues: "rk/plan/queues"');
    expect(yaml).toContain('lanes: "rk/plan/lanes"');
    expect(yaml).toContain('generated: "rk"');
    expect(yaml).toContain('registry: "rk/registry.json"');

    // Plan dirs created under <dir>/plan/.
    const planDirs = await readdir(join(cwd, 'rk', 'plan'));
    expect(planDirs).toContain('epics');
    expect(planDirs).toContain('sprints');
    expect(planDirs).toContain('reviews');
    expect(planDirs).toContain('queues');
    expect(planDirs).toContain('lanes');

    // Generated state lives directly under <dir>.
    const baseDirs = await readdir(join(cwd, 'rk'));
    expect(baseDirs).toContain('plan');
    expect(baseDirs).toContain('registry.json');

    // Banner reflects the custom base.
    expect(result.stdout).toContain('base dir:  rk');
    expect(result.stdout).toContain('plan dir:  rk/plan');
    expect(result.stdout).toContain('git add -- repokernel.config.yaml rk');

    // Nothing leaked into the default .repokernel directory.
    const rootDirs = await readdir(cwd);
    expect(rootDirs).not.toContain('.repokernel');
  });

  it('rejects --dir with absolute path', async () => {
    const result = await runInitCommand({
      cwd,
      nonInteractive: true,
      dir: '/etc/rk',
      io: NEVER_PROMPT_IO,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('relative to the project root');
  });

  it('rejects --dir with ".." traversal', async () => {
    const result = await runInitCommand({
      cwd,
      nonInteractive: true,
      dir: '../outside',
      io: NEVER_PROMPT_IO,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('".."');
  });
});
