import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctorCommand } from '../src/commands/doctor.js';
import { runInitCommand } from '../src/commands/init.js';
import type { PromptIO } from '../src/commands/initPrompts.js';

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
  await rm(cwd, { recursive: true, force: true });
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

    // doctor on a freshly seeded example should pass — sprints + queue exist.
    const doctorResult = await runDoctorCommand({ cwd });
    expect(doctorResult.exitCode).toBe(0);
    expect(doctorResult.stdout).toContain('RepoKernel setup looks good.');
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
});
