import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Config, ConfigSchema, RejectionRegistrySchema } from '@repokernel/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendRejection,
  loadRejections,
  matchRejection,
  nextRejectionId,
  rejectionsPath,
} from '../src/lifecycle/rejections.js';

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

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(
    tracked.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })),
  );
});

async function tmpProject(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'rk-rejections-'));
  tracked.push(cwd);
  await mkdir(join(cwd, '.repokernel'), { recursive: true });
  return cwd;
}

describe('rejectionsPath', () => {
  it('resolves under config.paths.generated', () => {
    const cwd = '/tmp/proj';
    expect(rejectionsPath(cwd, CONFIG)).toBe('/tmp/proj/.repokernel/rejections.json');
  });
});

describe('loadRejections', () => {
  it('returns an empty registry when the file is missing', async () => {
    const cwd = await tmpProject();
    const reg = await loadRejections(cwd, CONFIG);
    expect(reg.schemaVersion).toBe(1);
    expect(reg.rejections).toEqual([]);
  });

  it('throws on malformed JSON', async () => {
    const cwd = await tmpProject();
    await writeFile(rejectionsPath(cwd, CONFIG), '{ not json');
    await expect(loadRejections(cwd, CONFIG)).rejects.toThrow(/invalid JSON/);
  });

  it('throws on schema-invalid content', async () => {
    const cwd = await tmpProject();
    await writeFile(
      rejectionsPath(cwd, CONFIG),
      JSON.stringify({ schemaVersion: 1, rejections: [{ bogus: true }] }),
    );
    await expect(loadRejections(cwd, CONFIG)).rejects.toThrow(/schema validation failed/);
  });
});

describe('appendRejection', () => {
  const fixedNow = (): string => '2026-05-09T10:00:00.000Z';
  const fixedId = (): string => 'REJ-01HFAKEFAKEFAKEFAKEFAKEFAK';

  it('writes a new rejection and returns the added entry', async () => {
    const cwd = await tmpProject();
    const outcome = await appendRejection(cwd, CONFIG, {
      pattern: 'docker.*compose',
      reason: 'Out of scope per design discussion',
      scope: 'enhancement',
      created_by: 'xan@example.com',
      now: fixedNow,
      idGen: fixedId,
    });
    expect(outcome.duplicate).toBe(false);
    if (outcome.duplicate) return;
    expect(outcome.added.id).toBe('REJ-01HFAKEFAKEFAKEFAKEFAKEFAK');
    expect(outcome.added.created_at).toBe('2026-05-09T10:00:00.000Z');

    const onDisk = JSON.parse(await readFile(rejectionsPath(cwd, CONFIG), 'utf8'));
    const parsed = RejectionRegistrySchema.parse(onDisk);
    expect(parsed.rejections).toHaveLength(1);
    expect(parsed.rejections[0]?.pattern).toBe('docker.*compose');
  });

  it('appends a second distinct rejection without removing the first', async () => {
    const cwd = await tmpProject();
    await appendRejection(cwd, CONFIG, {
      pattern: 'docker.*compose',
      reason: 'Out of scope per design discussion',
      scope: 'enhancement',
      created_by: 'xan@example.com',
    });
    await appendRejection(cwd, CONFIG, {
      pattern: 'kubernetes.*operator',
      reason: 'Not within product surface area scope',
      scope: 'enhancement',
      created_by: 'xan@example.com',
    });
    const reg = await loadRejections(cwd, CONFIG);
    expect(reg.rejections.map((r) => r.pattern)).toEqual([
      'docker.*compose',
      'kubernetes.*operator',
    ]);
  });

  it('is idempotent on (pattern, scope) and returns the existing entry', async () => {
    const cwd = await tmpProject();
    const first = await appendRejection(cwd, CONFIG, {
      pattern: 'docker.*compose',
      reason: 'Out of scope per design discussion',
      scope: 'enhancement',
      created_by: 'xan@example.com',
      idGen: fixedId,
    });
    const second = await appendRejection(cwd, CONFIG, {
      pattern: 'docker.*compose',
      reason: 'Different reason but same pattern and scope at least 20 chars',
      scope: 'enhancement',
      created_by: 'someone-else@example.com',
    });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    if (!second.duplicate) return;
    expect(second.existing.id).toBe('REJ-01HFAKEFAKEFAKEFAKEFAKEFAK');
    const reg = await loadRejections(cwd, CONFIG);
    expect(reg.rejections).toHaveLength(1);
  });

  it('treats the same pattern under a different scope as a new entry', async () => {
    const cwd = await tmpProject();
    await appendRejection(cwd, CONFIG, {
      pattern: 'docker.*compose',
      reason: 'Out of scope per design discussion',
      scope: 'enhancement',
      created_by: 'xan@example.com',
    });
    const second = await appendRejection(cwd, CONFIG, {
      pattern: 'docker.*compose',
      reason: 'Bug-scope reason that is also at least 20 chars',
      scope: 'bug',
      created_by: 'xan@example.com',
    });
    expect(second.duplicate).toBe(false);
    const reg = await loadRejections(cwd, CONFIG);
    expect(reg.rejections).toHaveLength(2);
  });

  it('throws on a malformed regex pattern instead of writing', async () => {
    const cwd = await tmpProject();
    await expect(
      appendRejection(cwd, CONFIG, {
        pattern: '[unclosed',
        reason: 'Reason must be at least twenty chars',
        scope: 'enhancement',
        created_by: 'xan@example.com',
      }),
    ).rejects.toThrow(/not a valid JavaScript regex/);
    const reg = await loadRejections(cwd, CONFIG);
    expect(reg.rejections).toEqual([]);
  });
});

describe('matchRejection', () => {
  it('returns matches for patterns that hit title or body', () => {
    const registry = {
      schemaVersion: 1 as const,
      rejections: [
        {
          id: 'REJ-01HFAKEFAKEFAKEFAKEFAKEFAK',
          pattern: 'docker.*compose',
          reason: 'Out of scope per design discussion',
          scope: 'enhancement' as const,
          created_at: '2026-05-09T10:00:00.000Z',
          created_by: 'xan@example.com',
        },
      ],
    };
    expect(
      matchRejection(registry, { title: 'Add docker compose support', body: '' }),
    ).toHaveLength(1);
    expect(
      matchRejection(registry, {
        title: 'Unrelated request',
        body: 'mention DOCKER\ncompose here',
      }),
    ).toHaveLength(1);
    expect(matchRejection(registry, { title: 'unrelated', body: 'unrelated' })).toEqual([]);
  });

  it('skips entries whose pattern fails to compile', () => {
    const registry = {
      schemaVersion: 1 as const,
      rejections: [
        {
          id: 'REJ-01HFAKEFAKEFAKEFAKEFAKEFAK',
          pattern: '[unclosed',
          reason: 'Should never match because pattern is invalid',
          scope: 'enhancement' as const,
          created_at: '2026-05-09T10:00:00.000Z',
          created_by: 'xan@example.com',
        },
      ],
    };
    expect(matchRejection(registry, { title: 'anything', body: '' })).toEqual([]);
  });
});

describe('nextRejectionId', () => {
  it('produces 26-char ULIDs prefixed with REJ-', () => {
    expect(nextRejectionId()).toMatch(/^REJ-[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
