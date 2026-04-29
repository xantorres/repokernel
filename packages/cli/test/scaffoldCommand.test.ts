import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, describe, expect, it } from 'vitest';
import { runScaffoldCommandCommand } from '../src/commands/scaffold.js';
import { cleanupAllFixtures, defaultConfigYaml, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

async function project(): Promise<string> {
  return makeFixture([{ path: 'repokernel.config.yaml', content: defaultConfigYaml() }]);
}

async function readMarkdown(
  cwd: string,
  rel: string,
): Promise<{ data: Record<string, unknown>; body: string }> {
  const raw = await readFile(join(cwd, rel), 'utf8');
  const parsed = matter(raw);
  return { data: parsed.data as Record<string, unknown>, body: parsed.content };
}

describe('rk scaffold command — default emit', () => {
  it('writes .claude/commands/<name>.md with frontmatter + 1-line body pointing at protocol', async () => {
    const cwd = await project();
    const r = await runScaffoldCommandCommand('close-sprint', { cwd });
    expect(r.exitCode).toBe(0);
    const { data, body } = await readMarkdown(cwd, '.claude/commands/close-sprint.md');
    expect(data.description).toBeDefined();
    expect(typeof data.description).toBe('string');
    expect(data['arg-hint']).toBeDefined();
    // Body is the canonical 1-line pointer (whitespace-trimmed).
    expect(body.trim()).toContain('Read');
    expect(body.trim()).toContain('.agents/protocol/close-sprint.md');
    expect(body.trim()).toContain('Execute');
    expect(body.trim().split('\n').length).toBeLessThanOrEqual(2);
  });

  it('reports the path it created in stdout', async () => {
    const cwd = await project();
    const r = await runScaffoldCommandCommand('close-sprint', { cwd });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('.claude/commands/close-sprint.md');
  });

  it('does not embed any vendor model identifier in the generated file', async () => {
    const cwd = await project();
    await runScaffoldCommandCommand('close-sprint', { cwd });
    const raw = await readFile(join(cwd, '.claude/commands/close-sprint.md'), 'utf8');
    expect(raw).not.toMatch(/\b(haiku|sonnet|opus)\b/i);
    expect(raw).not.toMatch(/\bgpt-\d/i);
    expect(raw).not.toMatch(/\bclaude-\d/i);
  });
});

describe('rk scaffold command — flags', () => {
  it('--description and --arg-hint populate the frontmatter', async () => {
    const cwd = await project();
    const r = await runScaffoldCommandCommand('close-sprint', {
      cwd,
      description: 'Close a sprint and run review',
      argHint: '<SPRINT_ID>',
    });
    expect(r.exitCode).toBe(0);
    const { data } = await readMarkdown(cwd, '.claude/commands/close-sprint.md');
    expect(data.description).toBe('Close a sprint and run review');
    expect(data['arg-hint']).toBe('<SPRINT_ID>');
  });

  it('--tier records a tier hint comment in the file (no model name leaked)', async () => {
    const cwd = await project();
    await runScaffoldCommandCommand('close-sprint', { cwd, tier: 'orchestrate' });
    const raw = await readFile(join(cwd, '.claude/commands/close-sprint.md'), 'utf8');
    expect(raw).toContain('orchestrate');
  });

  it('--with-protocol also creates an empty .agents/protocol/<name>.md skeleton', async () => {
    const cwd = await project();
    const r = await runScaffoldCommandCommand('close-sprint', { cwd, withProtocol: true });
    expect(r.exitCode).toBe(0);
    const { body } = await readMarkdown(cwd, '.agents/protocol/close-sprint.md');
    expect(body).toContain('# close-sprint protocol');
    expect(body).toContain('## Inputs');
    expect(body).toContain('## Pre-checks');
    expect(body).toContain('## Loop');
    expect(body).toContain('## Halt conditions');
    expect(body).toContain('TODO');
    expect(r.stdout).toContain('.agents/protocol/close-sprint.md');
  });

  it('--commands-dir overrides the commands output directory', async () => {
    const cwd = await project();
    await runScaffoldCommandCommand('close-sprint', {
      cwd,
      commandsDir: 'custom/commands',
    });
    const { data } = await readMarkdown(cwd, 'custom/commands/close-sprint.md');
    expect(data.description).toBeDefined();
  });

  it('--protocol-dir overrides the protocol output directory when --with-protocol', async () => {
    const cwd = await project();
    await runScaffoldCommandCommand('close-sprint', {
      cwd,
      withProtocol: true,
      protocolDir: 'custom/protocol',
    });
    const { body } = await readMarkdown(cwd, 'custom/protocol/close-sprint.md');
    expect(body).toContain('# close-sprint protocol');
  });

  it('emits JSON envelope when --json is set', async () => {
    const cwd = await project();
    const r = await runScaffoldCommandCommand('close-sprint', {
      cwd,
      withProtocol: true,
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      created: string[];
      command_path: string;
      protocol_path: string | null;
    };
    expect(parsed.created).toEqual(
      expect.arrayContaining([
        '.claude/commands/close-sprint.md',
        '.agents/protocol/close-sprint.md',
      ]),
    );
    expect(parsed.command_path).toBe('.claude/commands/close-sprint.md');
    expect(parsed.protocol_path).toBe('.agents/protocol/close-sprint.md');
  });
});

describe('rk scaffold command — collisions and validation', () => {
  it('refuses to overwrite an existing command file unless --force', async () => {
    const cwd = await project();
    await mkdir(join(cwd, '.claude/commands'), { recursive: true });
    await writeFile(join(cwd, '.claude/commands/close-sprint.md'), 'existing content', 'utf8');

    const r = await runScaffoldCommandCommand('close-sprint', { cwd });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('exists');

    const raw = await readFile(join(cwd, '.claude/commands/close-sprint.md'), 'utf8');
    expect(raw).toBe('existing content');
  });

  it('--force overwrites the existing command file', async () => {
    const cwd = await project();
    await mkdir(join(cwd, '.claude/commands'), { recursive: true });
    await writeFile(join(cwd, '.claude/commands/close-sprint.md'), 'existing content', 'utf8');

    const r = await runScaffoldCommandCommand('close-sprint', { cwd, force: true });
    expect(r.exitCode).toBe(0);
    const { data } = await readMarkdown(cwd, '.claude/commands/close-sprint.md');
    expect(data.description).toBeDefined();
  });

  it('rejects names with invalid characters with EXIT_USAGE', async () => {
    const cwd = await project();
    const r = await runScaffoldCommandCommand('Bad Name!', { cwd });
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toContain('name');
  });

  it('rejects empty names with EXIT_USAGE', async () => {
    const cwd = await project();
    const r = await runScaffoldCommandCommand('', { cwd });
    expect(r.exitCode).toBe(64);
  });
});
