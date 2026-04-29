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
import { yamlArray, yamlScalar } from '../templates/yaml.js';
import { RK_GENERATED_BY } from '../version.js';
import { formatPostInitBanner } from './initBanner.js';
import {
  gatherInitChoices,
  type InitChoices,
  type InitPromptFlags,
  ownedPromptIO,
  type PromptIO,
} from './initPrompts.js';
import type { CommandResult } from './validate.js';

export interface InitCommandOptions {
  readonly cwd: string;
  readonly example?: boolean;
  readonly agent?: string;
  readonly lane?: string;
  readonly checksCmd?: string;
  readonly nonInteractive?: boolean;
  /** Override prompt IO for tests; defaults to a real readline. */
  readonly io?: PromptIO;
}

const CONFIG_FILE = 'repokernel.config.yaml';

export async function runInitCommand(opts: InitCommandOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  const created: string[] = [];
  const skipped: string[] = [];

  const configPath = join(cwd, CONFIG_FILE);
  const configExists = await exists(configPath);

  let choices: InitChoices;
  if (configExists) {
    skipped.push(CONFIG_FILE);
    // Don't prompt; choices will be re-derived from the loaded config below.
    choices = { agent: 'manual', lane: 'main', checksCmd: null, example: opts.example === true };
  } else {
    choices = await runPrompts(opts);
    await writeFile(configPath, defaultConfigYaml(cwd, choices), 'utf8');
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

  if (configExists) {
    choices = {
      agent: configResult.config.automation.defaultAgent,
      lane: configResult.config.policies.defaultLane,
      checksCmd: configResult.config.automation.checksCmd ?? null,
      example: opts.example === true,
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

  if (choices.example) {
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
      generatedBy: RK_GENERATED_BY,
    });
    await mkdir(dirname(registryPath), { recursive: true });
    await writeFile(registryPath, canonicalJson(registry), 'utf8');
    created.push(configResult.config.paths.registry);
  }

  const authorityPath = join(cwd, configResult.config.paths.generated, 'authority.md');
  if (await exists(authorityPath)) {
    skipped.push(`${configResult.config.paths.generated}/authority.md`);
  } else {
    await mkdir(dirname(authorityPath), { recursive: true });
    await writeFile(authorityPath, authorityTemplate(configResult.config.paths), 'utf8');
    created.push(`${configResult.config.paths.generated}/authority.md`);
  }

  const lines: string[] = [];
  if (created.length > 0) {
    lines.push('Created:');
    for (const path of created) lines.push(`  ${path}`);
  }
  if (skipped.length > 0) {
    if (created.length > 0) lines.push('');
    lines.push('Already existed:');
    for (const path of skipped) lines.push(`  ${path}`);
  }
  if (lines.length > 0) lines.push('');
  lines.push(
    formatPostInitBanner(choices, {
      config: CONFIG_FILE,
      planDir: dirname(configResult.config.paths.epics),
    }),
  );
  return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

async function runPrompts(opts: InitCommandOptions): Promise<InitChoices> {
  const flags: InitPromptFlags = {
    ...(opts.agent !== undefined && { agent: opts.agent }),
    ...(opts.lane !== undefined && { lane: opts.lane }),
    ...(opts.checksCmd !== undefined && { checksCmd: opts.checksCmd }),
    ...(opts.example !== undefined && { example: opts.example }),
    ...(opts.nonInteractive !== undefined && { nonInteractive: opts.nonInteractive }),
  };
  if (opts.io) {
    return gatherInitChoices(opts.io, flags);
  }
  const io = ownedPromptIO();
  try {
    return await gatherInitChoices(io, flags);
  } finally {
    io.close();
  }
}

function defaultConfigYaml(cwd: string, choices: InitChoices): string {
  const projectName = basename(cwd) || 'RepoKernel Project';
  const projectId = slug(projectName);
  const automationLines = [`  defaultAgent: ${JSON.stringify(choices.agent)}`];
  if (choices.checksCmd) {
    automationLines.push(`  checksCmd: ${JSON.stringify(choices.checksCmd)}`);
  }
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
  defaultLane: ${JSON.stringify(choices.lane)}
  severityFailThreshold: P1
automation:
${automationLines.join('\n')}
`;
}

interface Paths {
  readonly epics: string;
  readonly sprints: string;
  readonly reviews: string;
  readonly queues: string;
  readonly generated: string;
  readonly registry: string;
}

function authorityTemplate(paths: Paths): string {
  return `# Authority Hierarchy

Rules bind in this order (higher wins on conflict):

1. \`repokernel.config.yaml\` — config policies (validation thresholds, lane rules)
2. \`${paths.epics}/*.md\` — strategic intent and execution strategy
3. \`${paths.sprints}/*.md\` — tactical; newer supersedes older on same scope
4. \`${paths.queues}/*.md\` — execution ordering
5. \`${paths.registry}\` — informational, regenerable
`;
}

function isoOffset(daysAgo: number, hourOfDay = 9, minuteOfHour = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setUTCHours(hourOfDay, minuteOfHour, 0, 0);
  return `${d.toISOString().slice(0, 19)}Z`;
}

function exampleFiles(paths: Paths): { readonly path: string; readonly content: string }[] {
  const s001Start = isoOffset(7, 9);
  const s001Close = isoOffset(6, 10);
  const r001Created = isoOffset(6, 10, 5);
  const s002Start = isoOffset(2, 10, 30);

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
        startedAt: s001Start,
        closedAt: s001Close,
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
        startedAt: s002Start,
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
created_at: ${r001Created}
---

# R-001: Review S-001

## Findings

### CRITICAL (0)

### HIGH (0)

### MEDIUM (0)

### LOW (0)

## Open issues

## Retrospective
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
allowed_paths: []
denied_paths: []
generated_paths: []
review_required: true
review_id: ${yamlScalar(input.reviewId)}
started_at: ${yamlScalar(input.startedAt)}
closed_at: ${yamlScalar(input.closedAt)}
base_sha: ${yamlScalar(input.baseSha)}
end_sha: ${yamlScalar(input.endSha)}
target_date: null
adr_links: []
---

# ${input.id}: ${input.title}

## Objective

## Scope in

-

## Scope out

-

## Acceptance criteria

- [ ] Tests pass
- [ ]

## Dependencies

## Notes
<!-- append-only, dated -->
`;
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
