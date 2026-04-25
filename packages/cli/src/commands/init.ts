import { access, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  canonicalJson,
  generateRegistry,
  loadConfig,
  loadProject,
  RepoKernelError,
  runValidators,
} from '@repokernel/core';
import { EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import type { CommandResult } from './validate.js';

export interface InitCommandOptions {
  readonly cwd: string;
  readonly example: boolean;
}

const CONFIG_FILE = 'repokernel.config.yaml';

export async function runInitCommand(opts: InitCommandOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  const created: string[] = [];
  const skipped: string[] = [];

  const configPath = join(cwd, CONFIG_FILE);
  if (await exists(configPath)) {
    skipped.push(CONFIG_FILE);
  } else {
    await writeFile(configPath, defaultConfigYaml(cwd), 'utf8');
    created.push(CONFIG_FILE);
  }

  const configResult = await loadConfig({ cwd });
  if (!configResult.ok) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: 'repokernel.config.yaml exists but is invalid; fix it before running init again\n',
    };
  }

  const dirs = [
    configResult.config.paths.epics,
    configResult.config.paths.sprints,
    configResult.config.paths.reviews,
    configResult.config.paths.queues,
    configResult.config.paths.lanes,
    dirname(configResult.config.paths.registry),
  ];
  for (const dir of dirs) {
    const abs = join(cwd, dir);
    if (await exists(abs)) {
      skipped.push(dir);
    } else {
      await mkdir(abs, { recursive: true });
      created.push(dir);
    }
  }

  if (opts.example) {
    for (const file of exampleFiles(configResult.config.paths)) {
      const abs = join(cwd, file.path);
      if (await exists(abs)) {
        skipped.push(file.path);
      } else {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, file.content, 'utf8');
        created.push(file.path);
      }
    }
  }

  const registryPath = join(cwd, configResult.config.paths.registry);
  if (await exists(registryPath)) {
    skipped.push(configResult.config.paths.registry);
  } else {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) {
      return {
        exitCode: EXIT_RUNTIME,
        stdout: '',
        stderr: 'initialized files, but registry could not be generated; run repokernel validate\n',
      };
    }
    const findings = runValidators({
      graph: outcome.graph,
      config: outcome.config,
      parsed: outcome.parsed,
      parseFindings: outcome.parsed.findings,
    });
    const registry = generateRegistry({
      graph: outcome.graph,
      config: outcome.config,
      findings,
    });
    await mkdir(dirname(registryPath), { recursive: true });
    await writeFile(registryPath, canonicalJson(registry), 'utf8');
    created.push(configResult.config.paths.registry);
  }

  const lines = ['RepoKernel initialized.', ''];
  if (created.length > 0) {
    lines.push('Created:');
    for (const path of created) lines.push(`  ${path}`);
  }
  if (skipped.length > 0) {
    if (created.length > 0) lines.push('');
    lines.push('Already existed:');
    for (const path of skipped) lines.push(`  ${path}`);
  }
  lines.push('', 'Next:', '  repokernel validate', '  repokernel next');
  return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

function defaultConfigYaml(cwd: string): string {
  const projectName = basename(cwd) || 'RepoKernel Project';
  const projectId = slug(projectName);
  return `schemaVersion: 1
projectId: ${JSON.stringify(projectId)}
projectName: ${JSON.stringify(projectName)}
paths:
  epics: .repokernel/plan/epics
  sprints: .repokernel/plan/sprints
  reviews: .repokernel/plan/reviews
  queues: .repokernel/plan/queues
  lanes: .repokernel/plan/lanes
  generated: .repokernel
  registry: .repokernel/registry.json
policies:
  defaultLane: main
  severityFailThreshold: P1
`;
}

interface Paths {
  readonly epics: string;
  readonly sprints: string;
  readonly reviews: string;
  readonly queues: string;
}

function exampleFiles(paths: Paths): { readonly path: string; readonly content: string }[] {
  return [
    {
      path: join(paths.epics, 'E-001.md'),
      content: `---
id: E-001
title: Starter project
status: active
adr_links: []
sprints:
  - S-001
  - S-002
  - S-003
---

# E-001: Starter project
`,
    },
    {
      path: join(paths.sprints, 'S-001.md'),
      content: sprintTemplate({
        id: 'S-001',
        title: 'Ship starter foundation',
        status: 'shipped',
        dependsOn: [],
        reviewId: 'R-001',
        startedAt: '2026-04-25T09:00:00Z',
        closedAt: '2026-04-25T10:00:00Z',
        baseSha: 'a1b2c3d',
        endSha: 'b2c3d4e',
      }),
    },
    {
      path: join(paths.sprints, 'S-002.md'),
      content: sprintTemplate({
        id: 'S-002',
        title: 'Implement active starter work',
        status: 'active',
        dependsOn: ['S-001'],
        reviewId: null,
        startedAt: '2026-04-25T10:30:00Z',
        closedAt: null,
        baseSha: 'b2c3d4e',
        endSha: null,
      }),
    },
    {
      path: join(paths.sprints, 'S-003.md'),
      content: sprintTemplate({
        id: 'S-003',
        title: 'Implement registry drift detection',
        status: 'queued',
        dependsOn: ['S-001'],
        reviewId: null,
        startedAt: null,
        closedAt: null,
        baseSha: null,
        endSha: null,
      }),
    },
    {
      path: join(paths.queues, 'main.md'),
      content: `---
lane: main
slots:
  - id: Q-001
    sprint_id: S-002
    order: 0
  - id: Q-002
    sprint_id: S-003
    order: 1
---

# main queue
`,
    },
    {
      path: join(paths.reviews, 'R-001.md'),
      content: `---
id: R-001
sprint_id: S-001
verdict: accepted
reviewer: starter
findings: []
base_sha: a1b2c3d
end_sha: b2c3d4e
created_at: 2026-04-25T10:05:00Z
---

# R-001: Review S-001
`,
    },
  ];
}

function sprintTemplate(input: {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly dependsOn: readonly string[];
  readonly reviewId: string | null;
  readonly startedAt: string | null;
  readonly closedAt: string | null;
  readonly baseSha: string | null;
  readonly endSha: string | null;
}): string {
  return `---
id: ${input.id}
title: ${input.title}
epic_id: E-001
status: ${input.status}
lane: main
depends_on: ${yamlArray(input.dependsOn)}
blocked_by: []
allowed_paths:
  - packages/core/src/**
  - packages/core/test/**
denied_paths: []
generated_paths: []
review_required: true
review_id: ${yamlScalar(input.reviewId)}
started_at: ${yamlScalar(input.startedAt)}
closed_at: ${yamlScalar(input.closedAt)}
base_sha: ${yamlScalar(input.baseSha)}
end_sha: ${yamlScalar(input.endSha)}
---

# ${input.id}: ${input.title}

## Objective

## Acceptance Criteria

- [ ] AC-001:

## Non-goals

## Notes
`;
}

function yamlArray(values: readonly string[]): string {
  if (values.length === 0) return '[]';
  return `\n${values.map((value) => `  - ${value}`).join('\n')}`;
}

function yamlScalar(value: string | null): string {
  return value === null ? 'null' : value;
}

function slug(value: string): string {
  const out = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');
  return out || 'repokernel-project';
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return false;
    throw new RepoKernelError('IO_ERROR', `cannot access ${path}`, cause);
  }
}
