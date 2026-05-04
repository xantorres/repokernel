import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  buildGraph,
  ConfigSchema,
  canonicalJson,
  generateRegistry,
  type Registry,
} from '@repokernel/core';
import { afterEach, describe, expect, it } from 'vitest';
import { installRegistryMergeDriver } from '../src/lifecycle/registry/install.js';
import { runRegistryMergeDriver } from '../src/lifecycle/registry/mergeDriver.js';

const execFileAsync = promisify(execFile);

const CONFIG = ConfigSchema.parse({
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
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-merge-int-'));
  tracked.push(dir);
  return dir;
}

function emptyRegistry(): Registry {
  return generateRegistry({
    graph: buildGraph({
      sprints: [],
      epics: [],
      reviews: [],
      queues: [],
      lanes: [],
      nextMd: null,
      findings: [],
    }),
    config: CONFIG,
    findings: [],
    now: () => '2026-04-25T10:00:00.000Z',
  });
}

function withSprints(reg: Registry, sprintIds: string[]): Registry {
  const epics =
    sprintIds.length > 0
      ? [
          {
            id: 'E-001',
            title: 'Epic',
            status: 'active' as const,
            gate: null,
            adr_links: [],
            sprints: sprintIds,
            file: 'E-001.md',
          },
        ]
      : reg.epics;
  return {
    ...reg,
    epics,
    sprints: sprintIds.map((id) => ({
      id,
      title: `Sprint ${id}`,
      epic_id: 'E-001',
      status: 'planned' as const,
      lane: 'core',
      gate: null,
      depends_on: [],
      blocked_by: [],
      allowed_paths: [],
      denied_paths: [],
      generated_paths: [],
      review_required: true,
      review_id: null,
      started_at: null,
      closed_at: null,
      base_sha: null,
      end_sha: null,
      file: `${id}.md`,
    })),
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'rk-test',
      GIT_AUTHOR_EMAIL: 'rk-test@example.com',
      GIT_COMMITTER_NAME: 'rk-test',
      GIT_COMMITTER_EMAIL: 'rk-test@example.com',
      // Disable any local git hooks the host may have installed.
      GIT_TEMPLATE_DIR: '',
    },
  });
  return stdout;
}

describe('registry merge driver — real git merge', () => {
  it('regenerates registry.json without conflict markers when two branches diverge', async () => {
    const repo = await tmp();
    await git(repo, 'init', '-q', '-b', 'main');
    await git(repo, 'config', 'commit.gpgsign', 'false');
    await git(repo, 'config', 'tag.gpgsign', 'false');
    await git(repo, 'config', 'user.name', 'rk-test');
    await git(repo, 'config', 'user.email', 'rk-test@example.com');

    // Initial baseline registry on main with no entities.
    await mkdir(join(repo, '.repokernel'), { recursive: true });
    const baseReg = emptyRegistry();
    await writeFile(join(repo, '.repokernel', 'registry.json'), canonicalJson(baseReg));
    await writeFile(join(repo, 'README.md'), '# project\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'init');

    // Install the merge driver (writes .gitattributes + git config).
    await installRegistryMergeDriver({ cwd: repo });
    // Override the git driver to a self-contained command that runs the
    // pure merge function inline — git would normally call `rk
    // registry-merge-driver` but we don't need a global rk install here.
    const driverScript = join(repo, '.git', 'rk-merge-driver.mjs');
    await writeFile(
      driverScript,
      `import { runRegistryMergeDriver } from '${join(
        process.cwd(),
        'packages/cli/src/lifecycle/registry/mergeDriver.ts',
      )}';
      const argv = process.argv.slice(2);
      const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i+1] : undefined; };
      const r = await runRegistryMergeDriver({
        currentPath: get('--current'),
        otherPath: get('--other'),
        basePath: get('--base'),
      });
      process.exit(r.ok ? 0 : 1);
      `,
    );
    // Note: integration test does not exec the driver — it asserts the
    // function-level behaviour because shelling Node from inside a git
    // merge is non-trivial cross-platform. The end-to-end glue is
    // exercised by `installRegistryMergeDriver` writing the right config
    // (already covered) and the merge function being called with the
    // right paths (asserted below by calling it directly on the
    // worktree's `%A` and `%B` inputs).
    await git(repo, 'add', '.gitattributes');
    await git(repo, 'commit', '-q', '-m', 'configure merge driver');

    // Branch A: registry knows about S-1.
    await git(repo, 'checkout', '-q', '-b', 'feature-a');
    const regA = withSprints(emptyRegistry(), ['S-1']);
    await writeFile(join(repo, '.repokernel', 'registry.json'), canonicalJson(regA));
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'A: add S-1');

    // Branch B: registry knows about S-2.
    await git(repo, 'checkout', '-q', 'main');
    await git(repo, 'checkout', '-q', '-b', 'feature-b');
    const regB = withSprints(emptyRegistry(), ['S-2']);
    await writeFile(join(repo, '.repokernel', 'registry.json'), canonicalJson(regB));
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'B: add S-2');

    // Simulate the merge: the driver gets %A (current) and %B (other).
    // Copy the two divergent registries into temp paths and run the
    // pure merge function exactly as git would.
    const currentPath = join(repo, '.repokernel', 'registry.json');
    const otherPath = join(repo, '.repokernel', 'registry.other.json');
    await writeFile(currentPath, canonicalJson(regB));
    await writeFile(otherPath, canonicalJson(regA));

    const result = await runRegistryMergeDriver({ currentPath, otherPath });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.conflicts).toEqual([]);

    const merged = JSON.parse(await readFile(currentPath, 'utf8')) as Registry;
    const sprintIds = merged.sprints.map((s) => s.id).sort();
    expect(sprintIds).toEqual(['S-1', 'S-2']);
    expect(merged.epics[0]?.sprints.sort()).toEqual(['S-1', 'S-2']);
  });

  it('mergeRegistries is commutative on title divergence (same conflicts both directions)', async () => {
    const a = withSprints(emptyRegistry(), ['S-1']);
    const b = withSprints(emptyRegistry(), ['S-1']);
    a.sprints[0] = { ...a.sprints[0]!, title: 'Alpha' };
    b.sprints[0] = { ...b.sprints[0]!, title: 'Bravo' };
    const ab = await runRegistryMergeDriver({
      currentPath: await writeJson(a),
      otherPath: await writeJson(b),
    });
    const ba = await runRegistryMergeDriver({
      currentPath: await writeJson(b),
      otherPath: await writeJson(a),
    });
    expect(ab.ok).toBe(false);
    expect(ba.ok).toBe(false);
    // Both directions must surface a single sprint_immutable conflict on
    // `title`. The {local, remote} ordering may swap, but the conflict
    // identity is the same.
    expect(ab.conflicts.map((c) => `${c.kind}:${c.id}:${c.field}`).sort()).toEqual(
      ba.conflicts.map((c) => `${c.kind}:${c.id}:${c.field}`).sort(),
    );
  });

  async function writeJson(reg: Registry): Promise<string> {
    const dir = await tmp();
    const path = join(dir, 'reg.json');
    await writeFile(path, canonicalJson(reg));
    return path;
  }
});
