import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Run } from '@repokernel/core';
import matter from 'gray-matter';

const execFileAsync = promisify(execFile);

// — git helpers —

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args]);
  return stdout.trim();
}

export async function commitAll(cwd: string, message: string): Promise<void> {
  await execFileAsync('git', ['-C', cwd, 'add', '-A']);
  await execFileAsync('git', ['-C', cwd, 'commit', '--allow-empty', '-m', message]);
}

export async function makeGitRepo(prefix = 'rk-fa-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await execFileAsync('git', ['init', dir]);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@repokernel.test']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'RepoKernel Test']);
  await commitAll(dir, 'chore: init');
  return dir;
}

export async function removeRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['-C', dir, 'worktree', 'prune']).catch(() => null);
  await rm(dir, { recursive: true, force: true });
}

// — frontmatter helpers —

export async function readFm(file: string): Promise<Record<string, unknown>> {
  const raw = await readFile(file, 'utf8');
  return matter(raw).data as Record<string, unknown>;
}

// — run state helpers —

export function opRoot(repoDir: string): string {
  return join(repoDir, '.git', 'repokernel');
}

export async function loadRunFile(repoDir: string, runId: string): Promise<Run> {
  const raw = await readFile(join(opRoot(repoDir), 'runs', `${runId}.json`), 'utf8');
  return JSON.parse(raw) as Run;
}

export async function findRunId(repoDir: string): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  const runsDir = join(opRoot(repoDir), 'runs');
  const files = await readdir(runsDir);
  const runFile = files.find((f) => f.endsWith('.json'));
  if (!runFile) throw new Error('no run file found');
  return runFile.replace('.json', '');
}

// — project scaffold helpers —

export interface SprintSpec {
  readonly id: string;
  readonly title?: string;
  readonly depends_on?: string[];
  readonly gate?: string;
  readonly allowed_paths?: string[];
  readonly review_required?: boolean;
}

export interface EpicRepoOptions {
  readonly epicId?: string;
  readonly sprints: readonly SprintSpec[];
  readonly strategy?: 'sequential' | 'parallel';
  readonly parallelLimit?: number;
  readonly autonomousClose?: boolean;
  readonly worktreesRoot?: string;
  readonly requireReviewForShipped?: boolean;
}

function configYaml(opts: EpicRepoOptions): string {
  const lines = [
    'schemaVersion: 1',
    `projectId: fa-test`,
    `projectName: Fake Agent Test`,
    'paths:',
    '  epics: epics',
    '  sprints: sprints',
    '  reviews: reviews',
    '  queues: queues',
    '  lanes: lanes',
    '  generated: .repokernel',
    '  registry: .repokernel/registry.json',
    'policies:',
    `  requireReviewForShipped: ${opts.requireReviewForShipped ?? false}`,
  ];
  if (opts.autonomousClose) {
    lines.push('automation:');
    lines.push('  allowAutonomousClose: true');
  }
  if (opts.worktreesRoot) {
    lines.push('worktrees:');
    lines.push(`  root: ${opts.worktreesRoot}`);
    lines.push('  baseBranch: main');
  }
  return `${lines.join('\n')}\n`;
}

function epicYaml(opts: EpicRepoOptions): string {
  const epicId = opts.epicId ?? 'E-001';
  const lines = ['---', `id: "${epicId}"`, `title: "Test Epic ${epicId}"`, `status: "planned"`];
  if (opts.strategy === 'parallel') {
    lines.push(`execution_strategy: "parallel"`);
    if (opts.parallelLimit) lines.push(`parallel_limit: ${opts.parallelLimit}`);
  }
  lines.push(`sprints:`);
  for (const s of opts.sprints) lines.push(`  - "${s.id}"`);
  lines.push('---');
  return `${lines.join('\n')}\n`;
}

function sprintYaml(spec: SprintSpec, epicId: string): string {
  const lines = [
    '---',
    `id: "${spec.id}"`,
    `title: "${spec.title ?? `Sprint ${spec.id}`}"`,
    `epic_id: "${epicId}"`,
    `status: "queued"`,
    `lane: "main"`,
    `review_required: ${spec.review_required ?? false}`,
  ];
  if (spec.gate) lines.push(`gate: "${spec.gate}"`);
  if (spec.depends_on?.length) {
    lines.push('depends_on:');
    for (const d of spec.depends_on) lines.push(`  - "${d}"`);
  }
  if (spec.allowed_paths?.length) {
    lines.push('allowed_paths:');
    for (const p of spec.allowed_paths) lines.push(`  - "${p}"`);
  } else {
    lines.push(`allowed_paths:`);
    lines.push(`  - "workspace/${spec.id.toLowerCase()}"`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n`;
}

function queueYaml(sprints: readonly SprintSpec[]): string {
  const lines = ['---', `lane: "main"`, `slots:`];
  sprints.forEach((s, i) => {
    lines.push(`  - id: "Q-${String(i + 1).padStart(3, '0')}"`);
    lines.push(`    sprint_id: "${s.id}"`);
    lines.push(`    order: ${i}`);
  });
  lines.push('---');
  return `${lines.join('\n')}\n`;
}

export async function makeEpicRepo(opts: EpicRepoOptions): Promise<string> {
  const repoDir = await makeGitRepo();
  const epicId = opts.epicId ?? 'E-001';

  const dirs = ['epics', 'sprints', 'reviews', 'queues', 'lanes', '.repokernel'];
  await Promise.all(dirs.map((d) => mkdir(join(repoDir, d), { recursive: true })));

  await writeFile(join(repoDir, 'repokernel.config.yaml'), configYaml(opts), 'utf8');
  await writeFile(join(repoDir, 'epics', `${epicId}.md`), epicYaml(opts), 'utf8');

  for (const spec of opts.sprints) {
    await writeFile(join(repoDir, 'sprints', `${spec.id}.md`), sprintYaml(spec, epicId), 'utf8');
  }

  await writeFile(join(repoDir, 'queues', 'main.md'), queueYaml(opts.sprints), 'utf8');
  await commitAll(repoDir, 'chore: project setup');

  return repoDir;
}
