import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Config, ConfigSchema } from '@repokernel/core';
import { afterEach, describe, expect, it } from 'vitest';
import { runRejectCommand } from '../src/commands/reject.js';
import { loadRejections, rejectionsPath } from '../src/lifecycle/rejections.js';

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(
    tracked.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })),
  );
});

const CONFIG: Config = ConfigSchema.parse({
  schemaVersion: 1,
  projectId: 'demo',
  projectName: 'Demo',
  paths: {
    epics: 'epics',
    sprints: 'sprints',
    reviews: 'reviews',
    queues: 'queues',
    lanes: 'lanes',
    generated: '.repokernel',
    registry: '.repokernel/registry.json',
  },
});

async function tmpProject(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'rk-reject-'));
  tracked.push(cwd);
  await mkdir(join(cwd, '.repokernel'), { recursive: true });
  await mkdir(join(cwd, 'epics'), { recursive: true });
  await mkdir(join(cwd, 'sprints'), { recursive: true });
  await mkdir(join(cwd, 'reviews'), { recursive: true });
  await mkdir(join(cwd, 'queues'), { recursive: true });
  await mkdir(join(cwd, 'lanes'), { recursive: true });
  await writeFile(
    join(cwd, 'repokernel.config.yaml'),
    `schemaVersion: 1
projectId: ${CONFIG.projectId}
projectName: ${CONFIG.projectName}
paths:
  epics: ${CONFIG.paths.epics}
  sprints: ${CONFIG.paths.sprints}
  reviews: ${CONFIG.paths.reviews}
  queues: ${CONFIG.paths.queues}
  lanes: ${CONFIG.paths.lanes}
  generated: ${CONFIG.paths.generated}
  registry: ${CONFIG.paths.registry}
`,
  );
  return cwd;
}

describe('runRejectCommand', () => {
  it('writes a new rejection and exits 0', async () => {
    const cwd = await tmpProject();
    const result = await runRejectCommand({
      cwd,
      pattern: 'docker.*compose',
      reason: 'Out of scope per design discussion 2026-04-27',
      scope: 'enhancement',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Recorded rejection REJ-/);
    const reg = await loadRejections(cwd, CONFIG);
    expect(reg.rejections).toHaveLength(1);
    expect(reg.rejections[0]?.pattern).toBe('docker.*compose');
  });

  it('emits JSON when --json is set', async () => {
    const cwd = await tmpProject();
    const result = await runRejectCommand({
      cwd,
      pattern: 'docker.*compose',
      reason: 'Out of scope per design discussion 2026-04-27',
      scope: 'enhancement',
      json: true,
    });
    expect(result.exitCode).toBe(0);
    const env = JSON.parse(result.stdout);
    expect(env.action).toBe('created');
    expect(env.id).toMatch(/^REJ-/);
    expect(env.scope).toBe('enhancement');
    expect(env.tracker).toEqual({ attempted: false, ok: false });
  });

  it('reports duplicate when run twice with the same (pattern, scope)', async () => {
    const cwd = await tmpProject();
    await runRejectCommand({
      cwd,
      pattern: 'docker.*compose',
      reason: 'Out of scope per design discussion 2026-04-27',
      scope: 'enhancement',
    });
    const second = await runRejectCommand({
      cwd,
      pattern: 'docker.*compose',
      reason: 'Different reason but same pattern, also at least 20 chars',
      scope: 'enhancement',
      json: true,
    });
    expect(second.exitCode).toBe(0);
    const env = JSON.parse(second.stdout);
    expect(env.action).toBe('duplicate');
    const reg = await loadRejections(cwd, CONFIG);
    expect(reg.rejections).toHaveLength(1);
  });

  it('rejects malformed --ref values with a usage error', async () => {
    const cwd = await tmpProject();
    const result = await runRejectCommand({
      cwd,
      pattern: 'docker.*compose',
      reason: 'Out of scope per design discussion 2026-04-27',
      scope: 'enhancement',
      ref: 'not-a-real-ref',
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/--from-tracker value/);
  });

  it('returns RUNTIME error for malformed regex pattern without writing the file', async () => {
    const cwd = await tmpProject();
    const result = await runRejectCommand({
      cwd,
      pattern: '[unclosed',
      reason: 'Reason at least twenty chars long',
      scope: 'enhancement',
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/not a valid JavaScript regex/);
    const reg = await loadRejections(cwd, CONFIG);
    expect(reg.rejections).toEqual([]);
  });

  it('reports config-not-loaded clearly when project config is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'rk-reject-bare-'));
    tracked.push(cwd);
    const result = await runRejectCommand({
      cwd,
      pattern: 'docker.*compose',
      reason: 'Out of scope per design discussion 2026-04-27',
      scope: 'enhancement',
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(rejectionsPath(cwd, CONFIG)).toContain('.repokernel/rejections.json');
  });
});
