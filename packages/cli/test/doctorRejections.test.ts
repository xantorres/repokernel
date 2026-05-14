import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctorCommand } from '../src/commands/doctor.js';

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(
    tracked.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })),
  );
});

async function tmpProject(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'rk-doctor-rejections-'));
  tracked.push(cwd);
  for (const dir of ['.repokernel', 'epics', 'sprints', 'reviews', 'queues', 'lanes']) {
    await mkdir(join(cwd, dir), { recursive: true });
  }
  await writeFile(
    join(cwd, 'repokernel.config.yaml'),
    `schemaVersion: 1
projectId: demo
projectName: Demo
paths:
  epics: epics
  sprints: sprints
  reviews: reviews
  queues: queues
  lanes: lanes
  generated: .repokernel
  registry: .repokernel/registry.json
`,
  );
  return cwd;
}

describe('doctor rejections check', () => {
  it('passes silently when no rejections file exists', async () => {
    const cwd = await tmpProject();
    const result = await runDoctorCommand({ cwd, json: true });
    const env = JSON.parse(result.stdout);
    const titles: string[] = env.problems.map((p: { title: string }) => p.title);
    expect(titles.some((t) => t.toLowerCase().includes('rejection'))).toBe(false);
  });

  it('surfaces a JSON parse error when the file is malformed', async () => {
    const cwd = await tmpProject();
    await writeFile(join(cwd, '.repokernel', 'rejections.json'), '{ not json');
    const result = await runDoctorCommand({ cwd, json: true });
    const env = JSON.parse(result.stdout);
    const found = env.problems.find((p: { title: string }) =>
      p.title.includes('Invalid rejections file (JSON parse)'),
    );
    expect(found).toBeDefined();
    expect(result.exitCode).not.toBe(0);
  });

  it('surfaces a schema error when the file is wrong shape', async () => {
    const cwd = await tmpProject();
    await writeFile(
      join(cwd, '.repokernel', 'rejections.json'),
      JSON.stringify({ schemaVersion: 1, rejections: [{ bogus: true }] }),
    );
    const result = await runDoctorCommand({ cwd, json: true });
    const env = JSON.parse(result.stdout);
    const found = env.problems.find((p: { title: string }) =>
      p.title.includes('Invalid rejections file (schema)'),
    );
    expect(found).toBeDefined();
  });

  it('surfaces a per-entry pattern error when an ADR pattern is malformed', async () => {
    const cwd = await tmpProject();
    await writeFile(
      join(cwd, '.repokernel', 'rejections.json'),
      JSON.stringify({
        schemaVersion: 1,
        rejections: [
          {
            id: 'REJ-01HFAKEFAKEFAKEFAKEFAKEFAK',
            pattern: '[unclosed',
            reason: 'Reason at least twenty chars long',
            scope: 'enhancement',
            created_at: '2026-05-09T10:00:00.000Z',
            created_by: 'xan@example.com',
          },
        ],
      }),
    );
    const result = await runDoctorCommand({ cwd, json: true });
    const env = JSON.parse(result.stdout);
    const found = env.problems.find((p: { title: string }) =>
      p.title.includes('REJ-01HFAKEFAKEFAKEFAKEFAKEFAK'),
    );
    expect(found).toBeDefined();
    expect(found.title).toMatch(/malformed regex pattern/);
  });

  it('surfaces a per-entry pattern error when an ADR pattern is unsafe', async () => {
    const cwd = await tmpProject();
    await writeFile(
      join(cwd, '.repokernel', 'rejections.json'),
      JSON.stringify({
        schemaVersion: 1,
        rejections: [
          {
            id: 'REJ-01HFAKEFAKEFAKEFAKEFAKEFAK',
            pattern: '(a+)+$',
            reason: 'Reason at least twenty chars long',
            scope: 'enhancement',
            created_at: '2026-05-09T10:00:00.000Z',
            created_by: 'xan@example.com',
          },
        ],
      }),
    );
    const result = await runDoctorCommand({ cwd, json: true });
    const env = JSON.parse(result.stdout);
    const found = env.problems.find((p: { title: string }) =>
      p.title.includes('REJ-01HFAKEFAKEFAKEFAKEFAKEFAK'),
    );
    expect(found).toBeDefined();
    expect(found.title).toMatch(/unsafe regex pattern/);
  });
});
