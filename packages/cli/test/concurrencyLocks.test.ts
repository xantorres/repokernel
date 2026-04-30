import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterEach, describe, expect, it } from 'vitest';
import { claimLane, getLaneState, releaseLane } from '../src/lifecycle/laneState.js';

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-concur-'));
  tracked.push(dir);
  return dir;
}

describe('releaseLane under per-lane lock (PR4 finding 4)', () => {
  it('skips release when lane is owned by a different run', async () => {
    const opRoot = await tmp();
    await mkdir(join(opRoot, 'locks'), { recursive: true });
    await mkdir(join(opRoot, 'lanes'), { recursive: true });

    await claimLane('main', 'RUN-001', 'E-001', '/wt/RUN-001', 'rk/RUN-001', opRoot);

    // RUN-002 attempts to release a lane it does not own. The ownership
    // re-read under the lock surfaces RUN-001 and skips the unlink. Stderr
    // gets a warning; we silence it for the assertion.
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await releaseLane('main', opRoot, 'RUN-002');
    } finally {
      process.stderr.write = origWrite;
    }

    const after = await getLaneState('main', opRoot);
    expect(after?.run_id).toBe('RUN-001');
  });

  it('releases when the requesting run owns the lane', async () => {
    const opRoot = await tmp();
    await mkdir(join(opRoot, 'locks'), { recursive: true });
    await mkdir(join(opRoot, 'lanes'), { recursive: true });

    await claimLane('main', 'RUN-001', 'E-001', '/wt/RUN-001', 'rk/RUN-001', opRoot);
    await releaseLane('main', opRoot, 'RUN-001');

    const after = await getLaneState('main', opRoot);
    expect(after).toBeNull();
  });

  it('releases unconditionally when no ownerRunId is provided', async () => {
    const opRoot = await tmp();
    await mkdir(join(opRoot, 'locks'), { recursive: true });
    await mkdir(join(opRoot, 'lanes'), { recursive: true });

    await claimLane('main', 'RUN-001', 'E-001', '/wt/RUN-001', 'rk/RUN-001', opRoot);
    await releaseLane('main', opRoot);

    const after = await getLaneState('main', opRoot);
    expect(after).toBeNull();
  });
});

describe('appendSprintToEpic concurrency (PR4 finding 5)', () => {
  it('two concurrent rk create sprint invocations both land in the epic sprints[]', async () => {
    const { runCreateEpicCommand, runCreateSprintCommand } = await import(
      '../src/commands/create.js'
    );
    const cwd = await tmp();
    await writeFile(
      join(cwd, 'repokernel.config.yaml'),
      `schemaVersion: 1
projectId: pr4-concur
projectName: PR4 Concurrency Fixture
paths:
  epics: epics
  sprints: sprints
  reviews: reviews
  queues: queues
  lanes: lanes
  generated: .repokernel
  registry: .repokernel/registry.json
`,
      'utf8',
    );
    for (const p of ['epics', 'sprints', 'reviews', 'queues', 'lanes']) {
      await mkdir(join(cwd, p), { recursive: true });
    }

    const epicResult = await runCreateEpicCommand('Concurrency epic', { cwd });
    expect(epicResult.exitCode).toBe(0);
    const epicMatch = epicResult.stdout.match(/E-\d{3}/);
    expect(epicMatch).toBeTruthy();
    const epicId = epicMatch?.[0] as string;

    // Fire two creates against the same epic concurrently. With the
    // per-epic lock around appendSprintToEpic, both sprint ids must end
    // up in the epic frontmatter. Without the lock, the slower writer's
    // sprints[] would clobber the faster writer's.
    const [r1, r2] = await Promise.all([
      runCreateSprintCommand('First', {
        cwd,
        epic: epicId,
        lane: 'main',
        status: 'planned',
      }),
      runCreateSprintCommand('Second', {
        cwd,
        epic: epicId,
        lane: 'main',
        status: 'planned',
      }),
    ]);
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);

    const epicFile = await readFile(join(cwd, 'epics', `${epicId}.md`), 'utf8');
    const fm = matter(epicFile).data as { sprints?: string[] };
    expect(fm.sprints).toBeDefined();
    expect((fm.sprints ?? []).sort()).toEqual(['S-001', 'S-002']);
  });
});

describe('fastpath synthesize concurrency (PR4 finding 5)', () => {
  it('two concurrent fastpath synthesizes against the same lane never duplicate Q-NNN or sprint_id', async () => {
    const { synthesizeTaskState } = await import('../src/commands/fastpath/synthesize.js');
    const { loadConfig } = await import('@repokernel/core');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const cwd = await tmp();
    await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init', cwd]);
    await execFileAsync('git', ['-C', cwd, 'config', 'user.email', 't@rk.test']);
    await execFileAsync('git', ['-C', cwd, 'config', 'user.name', 'T']);
    await writeFile(
      join(cwd, 'repokernel.config.yaml'),
      `schemaVersion: 1
projectId: pr4-fp
projectName: PR4 Fastpath Concurrency
paths:
  epics: epics
  sprints: sprints
  reviews: reviews
  queues: queues
  lanes: lanes
  generated: .repokernel
  registry: .repokernel/registry.json
`,
      'utf8',
    );
    for (const p of ['epics', 'sprints', 'reviews', 'queues', 'lanes']) {
      await mkdir(join(cwd, p), { recursive: true });
    }
    await execFileAsync('git', ['-C', cwd, 'add', '-A']);
    await execFileAsync('git', ['-C', cwd, 'commit', '-m', 'init']);

    const cfg = await loadConfig({ cwd });
    if (!cfg.ok) throw new Error('config did not load');

    // Fire two synthesizes back-to-back. They serialize on the lane lock
    // inside the queue helper; with the lock removed (or pre-PR3 code),
    // the queue file would either lose one slot or duplicate a Q-id.
    const [a, b] = await Promise.all([
      synthesizeTaskState(cwd, cfg.config, {
        body: 'first task body',
        acceptanceCriteria: [],
        constraints: [],
        source: 'inline',
      }),
      synthesizeTaskState(cwd, cfg.config, {
        body: 'second task body',
        acceptanceCriteria: [],
        constraints: [],
        source: 'inline',
      }),
    ]);

    expect(a.queueFile).toBe(b.queueFile);
    const queue = matter(await readFile(a.queueFile, 'utf8')).data as {
      slots: Array<{ id: string; sprint_id: string; order: number }>;
    };
    expect(queue.slots).toHaveLength(2);
    const slotIds = new Set(queue.slots.map((s) => s.id));
    const sprintIds = new Set(queue.slots.map((s) => s.sprint_id));
    expect(slotIds.size).toBe(2);
    expect(sprintIds.size).toBe(2);
    expect(sprintIds.has(a.sprintId)).toBe(true);
    expect(sprintIds.has(b.sprintId)).toBe(true);
  });
});
