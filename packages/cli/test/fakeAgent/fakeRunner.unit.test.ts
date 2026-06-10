/**
 * Unit tests for FakeRunner in isolation.
 *
 * Each test creates a minimal git repo so FakeRunner can commit.
 * No full project scaffold needed — just a worktree path with git.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRunner } from '../../src/agents/fake.js';
import { runId, sid } from '../helpers/brand.js';
import { git, makeGitRepo, opRoot, removeRepo } from './helpers.js';

let repoDir: string;
let runner: FakeRunner;

beforeEach(async () => {
  repoDir = await makeGitRepo('rk-fa-unit-');
  runner = new FakeRunner();
});

afterEach(async () => {
  await removeRepo(repoDir);
});

function baseInput(overrides: Partial<Parameters<FakeRunner['runSprint']>[0]> = {}) {
  const op = opRoot(repoDir);
  return {
    run_id: runId('RUN-001'),
    epic_id: 'E-001' as `E-${string}`,
    sprint_id: sid('S-001'),
    worktree: repoDir,
    control_cwd: repoDir,
    op_root: op,
    sprint_packet_path: join(op, 'runs', 'RUN-001', 'sprint-packets', 'S-001.md'),
    registry_path: join(repoDir, '.repokernel', 'registry.json'),
    mode: 'assisted' as const,
    ...overrides,
  };
}

async function writePacket(content: string): Promise<string> {
  const packetDir = join(opRoot(repoDir), 'runs', 'RUN-001', 'sprint-packets');
  await mkdir(packetDir, { recursive: true });
  const path = join(packetDir, 'S-001.md');
  await (await import('node:fs/promises')).writeFile(path, content, 'utf8');
  return path;
}

describe('FakeRunner.name', () => {
  it('is "fake"', () => {
    expect(runner.name).toBe('fake');
  });
});

describe('FakeRunner.runSprint — output file', () => {
  it('creates repokernel-fake-{sprint_id}.txt in first allowed path', async () => {
    const packetPath = await writePacket('## Allowed Paths\n- `workspace/alpha`\n');
    const result = await runner.runSprint(baseInput({ sprint_packet_path: packetPath }));
    const expectedFile = join(repoDir, 'workspace/alpha', 'repokernel-fake-S-001.txt');
    const content = await readFile(expectedFile, 'utf8');
    expect(content).toBeTruthy();
    expect(result.changed_files[0]).toBe(join('workspace/alpha', 'repokernel-fake-S-001.txt'));
  });

  it('falls back to fake-output/ when no allowed paths in packet', async () => {
    const result = await runner.runSprint(baseInput());
    expect(result.changed_files[0]).toContain('repokernel-fake-S-001.txt');
    const fallbackFile = join(repoDir, 'fake-output', 'repokernel-fake-S-001.txt');
    const content = await readFile(fallbackFile, 'utf8');
    expect(content).toBeTruthy();
  });

  it('file content contains sprint_id and run_id', async () => {
    const result = await runner.runSprint(baseInput());
    const filePath = join(repoDir, result.changed_files[0]!);
    const content = await readFile(filePath, 'utf8');
    expect(content).toContain('S-001');
    expect(content).toContain('RUN-001');
  });

  it('uses first path when packet has multiple allowed paths', async () => {
    const packetPath = await writePacket(
      '## Allowed Paths\n- `workspace/first`\n- `workspace/second`\n',
    );
    const result = await runner.runSprint(baseInput({ sprint_packet_path: packetPath }));
    expect(result.changed_files[0]).toContain('workspace/first');
    expect(result.changed_files[0]).not.toContain('workspace/second');
  });

  it('different sprint IDs produce distinct file names', async () => {
    const runner2 = new FakeRunner();
    const r1 = await runner.runSprint(baseInput({ sprint_id: sid('S-001') }));
    const r2 = await runner2.runSprint(
      baseInput({
        sprint_id: sid('S-002'),
        sprint_packet_path: join(opRoot(repoDir), 'runs', 'RUN-001', 'sprint-packets', 'S-002.md'),
      }),
    );
    expect(r1.changed_files[0]).toContain('S-001');
    expect(r2.changed_files[0]).toContain('S-002');
    expect(r1.changed_files[0]).not.toBe(r2.changed_files[0]);
  });
});

describe('FakeRunner.runSprint — git commit', () => {
  it('commits with message feat({sprint_id}): fake implementation', async () => {
    await runner.runSprint(baseInput());
    const log = await git(repoDir, 'log', '--oneline', '-1');
    expect(log).toContain('feat(S-001): fake implementation');
  });

  it('fake output file appears in git log', async () => {
    await runner.runSprint(baseInput());
    const show = await git(repoDir, 'show', '--stat', 'HEAD');
    expect(show).toContain('repokernel-fake-S-001.txt');
  });

  it('working tree is clean after runSprint', async () => {
    await runner.runSprint(baseInput());
    const status = await git(repoDir, 'status', '--porcelain');
    expect(status).toBe('');
  });
});

describe('FakeRunner.runSprint — return value', () => {
  it('returns status: completed', async () => {
    const result = await runner.runSprint(baseInput());
    expect(result.status).toBe('completed');
  });

  it('returns non-empty summary', async () => {
    const result = await runner.runSprint(baseInput());
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it('summary contains sprint_id', async () => {
    const result = await runner.runSprint(baseInput());
    expect(result.summary).toContain('S-001');
  });

  it('changed_files is non-empty array', async () => {
    const result = await runner.runSprint(baseInput());
    expect(result.changed_files).toHaveLength(1);
    expect(result.changed_files[0]).toBeTruthy();
  });

  it('needs_human is true in assisted mode', async () => {
    const result = await runner.runSprint(baseInput({ mode: 'assisted' }));
    expect(result.needs_human).toBe(true);
  });

  it('needs_human is false in autonomous mode', async () => {
    const result = await runner.runSprint(baseInput({ mode: 'autonomous' }));
    expect(result.needs_human).toBe(false);
  });

  it('handles missing packet file gracefully (no throw)', async () => {
    const result = await runner.runSprint(baseInput());
    expect(result.status).toBe('completed');
  });
});

describe('FakeRunner.runSprint — packet parsing', () => {
  it('parses allowed paths from packet markdown', async () => {
    const packetPath = await writePacket(
      '# Sprint\n\n## Allowed Paths\n\n- `src/components`\n- `src/utils`\n\n## Output Contract\n',
    );
    const result = await runner.runSprint(baseInput({ sprint_packet_path: packetPath }));
    expect(result.changed_files[0]).toContain('src/components');
  });

  it('resolves deep glob pattern to concrete base dir', async () => {
    const packetPath = await writePacket('## Allowed Paths\n- `packages/core/src/**`\n');
    const result = await runner.runSprint(baseInput({ sprint_packet_path: packetPath }));
    expect(result.changed_files[0]).toContain('packages/core/src');
    expect(result.changed_files[0]).not.toContain('**');
  });

  it('resolves wildcard segment to parent dir', async () => {
    const packetPath = await writePacket('## Allowed Paths\n- `packages/*/src/**`\n');
    const result = await runner.runSprint(baseInput({ sprint_packet_path: packetPath }));
    expect(result.changed_files[0]).toContain('packages');
    expect(result.changed_files[0]).not.toContain('*');
  });

  it('concrete path unchanged by resolver', async () => {
    const packetPath = await writePacket('## Allowed Paths\n- `workspace/alpha`\n');
    const result = await runner.runSprint(baseInput({ sprint_packet_path: packetPath }));
    expect(result.changed_files[0]).toContain('workspace/alpha');
  });

  it('handles malformed packet without throwing', async () => {
    const packetDir = join(opRoot(repoDir), 'runs', 'RUN-001', 'sprint-packets');
    await mkdir(packetDir, { recursive: true });
    const badPath = join(packetDir, 'S-001.md');
    await (await import('node:fs/promises')).writeFile(badPath, 'no allowed paths section', 'utf8');
    const result = await runner.runSprint(baseInput({ sprint_packet_path: badPath }));
    expect(result.status).toBe('completed');
    expect(result.changed_files[0]).toContain('fake-output');
  });
});
