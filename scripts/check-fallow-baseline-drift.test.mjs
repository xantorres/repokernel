import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repoRoot, 'scripts/check-fallow-baseline-drift.mjs');

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeBaselines(dir, counts) {
  await writeJson(join(dir, 'dead-code.json'), {
    unused_files: Array.from({ length: counts.deadCode }, (_, i) => `file-${i}.ts`),
    unused_exports: [],
  });
  await writeJson(join(dir, 'dupes.json'), {
    clone_groups: Array.from({ length: counts.dupes }, (_, i) => `clone-${i}`),
  });
  await writeJson(join(dir, 'health.json'), {
    finding_counts: {
      'file.ts': {
        crap_high: { count: counts.health },
      },
    },
  });
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'rk-fallow-baseline-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(base, head) {
  return spawnSync(process.execPath, [script, '--base', base, '--head', head], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('passes when current baselines do not grow', async () => {
  await withTempDir(async (dir) => {
    const base = join(dir, 'base');
    const head = join(dir, 'head');
    await writeBaselines(base, { deadCode: 2, dupes: 2, health: 2 });
    await writeBaselines(head, { deadCode: 1, dupes: 2, health: 0 });

    const result = run(base, head);

    assert.equal(result.status, 0, result.stderr);
  });
});

test('fails when any baseline grows', async () => {
  await withTempDir(async (dir) => {
    const base = join(dir, 'base');
    const head = join(dir, 'head');
    await writeBaselines(base, { deadCode: 1, dupes: 1, health: 1 });
    await writeBaselines(head, { deadCode: 2, dupes: 1, health: 3 });

    const result = run(base, head);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /dead-code baseline grew/);
    assert.match(result.stderr, /health baseline grew/);
  });
});

test('allows bootstrap when base baselines are absent', async () => {
  await withTempDir(async (dir) => {
    const base = join(dir, 'base');
    const head = join(dir, 'head');
    await mkdir(base, { recursive: true });
    await writeBaselines(head, { deadCode: 2, dupes: 2, health: 2 });

    const result = run(base, head);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /allowing bootstrap/);
  });
});

test('fails closed when a baseline has an unexpected shape', async () => {
  await withTempDir(async (dir) => {
    const base = join(dir, 'base');
    const head = join(dir, 'head');
    await writeBaselines(base, { deadCode: 1, dupes: 1, health: 1 });
    await writeBaselines(head, { deadCode: 1, dupes: 1, health: 1 });
    await writeJson(join(head, 'health.json'), {
      finding_counts: {
        'file.ts': {
          crap_high: { count: '1' },
        },
      },
    });

    const result = run(base, head);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /must be a non-negative integer/);
  });
});
