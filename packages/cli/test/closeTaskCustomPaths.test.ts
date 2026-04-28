import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from '@repokernel/core';
import { afterEach, describe, expect, it } from 'vitest';
import { commitWorktreeRkMetadata } from '../src/commands/fastpath/closeTask.js';

const execFileAsync = promisify(execFile);

interface PathsLayout {
  readonly name: string;
  readonly epics: string;
  readonly sprints: string;
  readonly reviews: string;
  readonly queues: string;
  readonly lanes: string;
  readonly generated: string;
  readonly registry: string;
}

const LAYOUTS: readonly PathsLayout[] = [
  {
    name: 'default-repokernel-only',
    epics: '.repokernel/plan/epics',
    sprints: '.repokernel/plan/sprints',
    reviews: '.repokernel/plan/reviews',
    queues: '.repokernel/plan/queues',
    lanes: '.repokernel/plan/lanes',
    generated: '.repokernel',
    registry: '.repokernel/registry.json',
  },
  {
    name: 'flat-rk',
    epics: 'rk/epics',
    sprints: 'rk/sprints',
    reviews: 'rk/reviews',
    queues: 'rk/queues',
    lanes: 'rk/lanes',
    generated: 'rk',
    registry: 'rk/registry.json',
  },
  {
    name: 'docs-layout',
    epics: 'docs/epics',
    sprints: 'docs/sprints',
    reviews: 'docs/reviews',
    queues: 'docs/queues',
    lanes: 'docs/lanes',
    generated: '.repokernel',
    registry: '.repokernel/registry.json',
  },
  {
    name: 'mixed-split',
    epics: 'state/epics',
    sprints: 'state/sprints',
    reviews: 'state/reviews',
    queues: '.queue',
    lanes: 'state/lanes',
    generated: '.repokernel',
    registry: '.repokernel/registry.json',
  },
];

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeRepo(layout: PathsLayout): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-cp-'));
  tracked.push(dir);
  await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init', dir]);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@rk.test']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'RK Test']);

  const cfg = `schemaVersion: 1
projectId: cp-test
projectName: Custom Path Test
paths:
  epics: ${layout.epics}
  sprints: ${layout.sprints}
  reviews: ${layout.reviews}
  queues: ${layout.queues}
  lanes: ${layout.lanes}
  generated: ${layout.generated}
  registry: ${layout.registry}
`;
  await writeFile(join(dir, 'repokernel.config.yaml'), cfg, 'utf8');

  for (const p of [
    layout.epics,
    layout.sprints,
    layout.reviews,
    layout.queues,
    layout.lanes,
    layout.generated,
  ]) {
    await mkdir(join(dir, p), { recursive: true });
  }
  await writeFile(join(dir, layout.epics, '.gitkeep'), '', 'utf8');
  await writeFile(join(dir, layout.sprints, '.gitkeep'), '', 'utf8');
  await writeFile(join(dir, layout.reviews, '.gitkeep'), '', 'utf8');
  await writeFile(join(dir, layout.queues, '.gitkeep'), '', 'utf8');
  await writeFile(join(dir, layout.lanes, '.gitkeep'), '', 'utf8');
  await writeFile(join(dir, layout.registry), '{}', 'utf8');

  await execFileAsync('git', ['-C', dir, 'add', '-A']);
  await execFileAsync('git', ['-C', dir, 'commit', '-m', 'init']);
  return dir;
}

async function gitLogFiles(dir: string, ref = 'HEAD'): Promise<string> {
  const { stdout } = await execFileAsync('git', [
    '-C',
    dir,
    'log',
    '-1',
    '--name-only',
    '--pretty=',
    ref,
  ]);
  return stdout;
}

describe('commitWorktreeRkMetadata custom-path correctness', () => {
  for (const layout of LAYOUTS) {
    it(`commits a dirty sprint file under ${layout.name}`, async () => {
      const dir = await makeRepo(layout);
      const cfg = await loadConfig({ cwd: dir });
      if (!cfg.ok) throw new Error(`config load failed: ${JSON.stringify(cfg)}`);

      // Dirty the sprint file the way the run pipeline would: mutate the
      // status field. We just write fresh content to make `git status` notice.
      const sprintFile = join(dir, layout.sprints, 'S-001.md');
      await writeFile(
        sprintFile,
        `---\nid: "S-001"\ntitle: "Custom-path close test"\nstatus: "review"\nlane: "main"\n---\nbody\n`,
        'utf8',
      );

      // Sanity: confirm git sees the new file before staging.
      const { stdout: pre } = await execFileAsync('git', ['-C', dir, 'status', '--porcelain']);
      expect(pre).toContain('S-001.md');

      await commitWorktreeRkMetadata(dir, cfg.config);

      // After the helper runs, working tree must be clean and the new file
      // must show up in HEAD's commit, regardless of layout.
      const { stdout: post } = await execFileAsync('git', ['-C', dir, 'status', '--porcelain']);
      expect(post.trim()).toBe('');

      const head = await gitLogFiles(dir);
      expect(head).toContain('S-001.md');
      // The relevant sprint path is also part of HEAD
      expect(head).toContain(layout.sprints);
    });

    it(`commits a dirty review file and queue file under ${layout.name}`, async () => {
      const dir = await makeRepo(layout);
      const cfg = await loadConfig({ cwd: dir });
      if (!cfg.ok) throw new Error('config load failed');

      const reviewFile = join(dir, layout.reviews, 'R-001.md');
      const queueFile = join(dir, layout.queues, 'main.md');
      await writeFile(
        reviewFile,
        `---\nid: "R-001"\nsprint_id: "S-001"\nverdict: "pending"\n---\n`,
        'utf8',
      );
      await writeFile(queueFile, `---\nlane: "main"\nslots: []\n---\n`, 'utf8');

      await commitWorktreeRkMetadata(dir, cfg.config);

      const { stdout: post } = await execFileAsync('git', ['-C', dir, 'status', '--porcelain']);
      expect(post.trim()).toBe('');

      const head = await gitLogFiles(dir);
      expect(head).toContain('R-001.md');
      expect(head).toContain('main.md');
    });

    it(`is a no-op when no RK-managed paths are dirty under ${layout.name}`, async () => {
      const dir = await makeRepo(layout);
      const cfg = await loadConfig({ cwd: dir });
      if (!cfg.ok) throw new Error('config load failed');

      const headBefore = (
        await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD'])
      ).stdout.trim();

      await commitWorktreeRkMetadata(dir, cfg.config);

      const headAfter = (
        await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD'])
      ).stdout.trim();
      expect(headAfter).toBe(headBefore);
    });

    it(`ignores dirty files outside RK-managed paths under ${layout.name}`, async () => {
      const dir = await makeRepo(layout);
      const cfg = await loadConfig({ cwd: dir });
      if (!cfg.ok) throw new Error('config load failed');

      // Write a file in a totally unrelated directory — RK must not stage it.
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'app.ts'), 'export const x = 1;', 'utf8');

      const headBefore = (
        await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD'])
      ).stdout.trim();

      await commitWorktreeRkMetadata(dir, cfg.config);

      const headAfter = (
        await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD'])
      ).stdout.trim();
      expect(headAfter).toBe(headBefore);

      // The user file is still untracked (unstaged) — RK left it alone. Git
      // collapses untracked directories to `?? src/` in --porcelain v1, so we
      // assert the directory marker rather than the leaf path.
      const { stdout: status } = await execFileAsync('git', ['-C', dir, 'status', '--porcelain']);
      expect(status).toMatch(/\?\?\s+src\//);
    });
  }
});
