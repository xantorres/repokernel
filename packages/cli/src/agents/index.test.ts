import type { AgentDefinition } from '@repokernel/core';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PRESETS } from './catalog.js';
import { ExternalRunner } from './external.js';
import { FakeRunner } from './fake.js';
import { getRunner } from './index.js';
import { ManualRunner } from './manual.js';

const CUSTOM_DEF: AgentDefinition = {
  command: 'custom-agent',
  args: ['--packet', '{packet_path}'],
  resultFormat: 'sentinel-json',
  timeoutSeconds: 900,
  envPassthrough: [],
};

describe('getRunner', () => {
  it('resolves claude preset when no user config', () => {
    const runner = getRunner('claude');
    expect(runner).toBeInstanceOf(ExternalRunner);
    expect(runner.name).toBe('claude');
    expect((runner as ExternalRunner).command).toBe('claude');
  });

  it('user config overrides claude preset', () => {
    const runner = getRunner('claude', { claude: CUSTOM_DEF }) as ExternalRunner;
    expect(runner).toBeInstanceOf(ExternalRunner);
    expect(runner.command).toBe('custom-agent');
  });

  it('resolves codex preset when no user config', () => {
    const runner = getRunner('codex');
    expect(runner).toBeInstanceOf(ExternalRunner);
    expect(runner.name).toBe('codex');
    expect((runner as ExternalRunner).command).toBe('codex');
  });

  it('codex preset defaults to the worktree-confined sandbox', () => {
    const preset = BUILTIN_PRESETS.codex;
    expect(preset).toBeDefined();
    expect(preset?.command).toBe('codex');
    expect(preset?.args).toEqual([
      'exec',
      '--cd',
      '{worktree}',
      '--sandbox',
      'workspace-write',
      'Read and follow the RepoKernel sprint packet at {packet_path}. Emit the required RepoKernel sentinel block when complete.',
    ]);
    expect(preset?.args).not.toContain('danger-full-access');
    expect(preset?.args).not.toContain('--approval-mode');
    expect(preset?.args).not.toContain('full-auto');
    expect(preset?.args).not.toContain('-q');
  });

  it('codex-danger preset opts into full host access', () => {
    const preset = BUILTIN_PRESETS['codex-danger'];
    expect(preset).toBeDefined();
    expect(preset?.command).toBe('codex');
    expect(preset?.args).toEqual([
      'exec',
      '--cd',
      '{worktree}',
      '--sandbox',
      'danger-full-access',
      'Read and follow the RepoKernel sprint packet at {packet_path}. Emit the required RepoKernel sentinel block when complete.',
    ]);
  });

  it('resolves codex-danger preset when no user config', () => {
    const runner = getRunner('codex-danger');
    expect(runner).toBeInstanceOf(ExternalRunner);
    expect(runner.name).toBe('codex-danger');
    expect((runner as ExternalRunner).command).toBe('codex');
  });

  it('returns ManualRunner for manual', () => {
    expect(getRunner('manual')).toBeInstanceOf(ManualRunner);
  });

  it('returns FakeRunner for fake', () => {
    expect(getRunner('fake')).toBeInstanceOf(FakeRunner);
  });

  it('manual is reserved — user config cannot override it', () => {
    expect(getRunner('manual', { manual: CUSTOM_DEF })).toBeInstanceOf(ManualRunner);
  });

  it('fake is reserved — user config cannot override it', () => {
    expect(getRunner('fake', { fake: CUSTOM_DEF })).toBeInstanceOf(FakeRunner);
  });

  it('throws with actionable message for unknown agent', () => {
    expect(() => getRunner('notreal')).toThrow(
      'unknown agent: "notreal" (available: manual, fake, ollama, presets: claude, codex, codex-danger, or define agents.notreal in repokernel.config.yaml)',
    );
  });

  it('resolves user-defined custom agent by name', () => {
    const runner = getRunner('my-agent', { 'my-agent': CUSTOM_DEF }) as ExternalRunner;
    expect(runner).toBeInstanceOf(ExternalRunner);
    expect(runner.name).toBe('my-agent');
    expect(runner.command).toBe('custom-agent');
  });

  it('user config takes priority over presets when both exist', () => {
    const runner = getRunner('codex', { codex: CUSTOM_DEF }) as ExternalRunner;
    expect(runner.command).toBe('custom-agent');
  });
});
