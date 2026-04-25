import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  loadConfig,
  loadProject,
  RegistrySchema,
  RepoKernelError,
  runValidators,
} from '@repokernel/core';
import { EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import type { CommandResult } from './validate.js';

export interface FixCommandOptions {
  readonly cwd: string;
  readonly preview: boolean;
  readonly json?: boolean;
}

interface SafeFix {
  readonly title: string;
  readonly detail: string;
}

interface FixPreview {
  readonly safeFixes: readonly SafeFix[];
  readonly manualSuggestions: readonly SafeFix[];
}

export async function runFixCommand(opts: FixCommandOptions): Promise<CommandResult> {
  if (!opts.preview) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: 'repokernel fix only supports --preview in v0\n',
    };
  }

  const preview = await collectFixPreview(opts.cwd);

  if (opts.json) {
    return {
      exitCode: EXIT_OK,
      stdout: emitJson({ schemaVersion: 1, ...preview }) + '\n',
      stderr: '',
    };
  }

  const lines = ['Available safe fixes:', ''];
  if (preview.safeFixes.length === 0) {
    lines.push('No safe mechanical fixes found.');
  } else {
    preview.safeFixes.forEach((fix, index) => {
      lines.push(`${index + 1}. ${fix.title}`);
      lines.push(`   ${fix.detail}`);
      if (index !== preview.safeFixes.length - 1) lines.push('');
    });
  }

  if (preview.manualSuggestions.length > 0) {
    lines.push('', 'Manual suggestions:', '');
    preview.manualSuggestions.forEach((suggestion, index) => {
      lines.push(`${index + 1}. ${suggestion.title}`);
      lines.push(`   ${suggestion.detail}`);
      if (index !== preview.manualSuggestions.length - 1) lines.push('');
    });
  }
  return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

async function collectFixPreview(cwd: string): Promise<FixPreview> {
  const safeFixes: SafeFix[] = [];
  const manualSuggestions: SafeFix[] = [];
  const config = await loadConfig({ cwd }).catch((cause) => {
    if (cause instanceof RepoKernelError && cause.kind === 'CONFIG_FILE_NOT_FOUND') return null;
    throw cause;
  });

  if (config === null) {
    return {
      safeFixes: [{ title: 'Create RepoKernel config and folders', detail: 'repokernel init' }],
      manualSuggestions,
    };
  }
  if (!config.ok) {
    return { safeFixes, manualSuggestions };
  }

  for (const dir of [
    config.config.paths.epics,
    config.config.paths.sprints,
    config.config.paths.reviews,
    config.config.paths.queues,
    config.config.paths.lanes,
    dirname(config.config.paths.registry),
  ]) {
    if (!(await exists(join(cwd, dir)))) {
      safeFixes.push({ title: `Create missing directory`, detail: dir });
    }
  }

  const registryPath = join(cwd, config.config.paths.registry);
  if (!(await exists(registryPath))) {
    safeFixes.push({ title: 'Generate missing registry', detail: 'repokernel registry --write' });
  } else {
    try {
      const raw = JSON.parse(await readFile(registryPath, 'utf8')) as unknown;
      if (!RegistrySchema.safeParse(raw).success) {
        safeFixes.push({
          title: 'Regenerate invalid registry',
          detail: 'repokernel registry --write',
        });
      }
    } catch {
      safeFixes.push({
        title: 'Regenerate invalid registry',
        detail: 'repokernel registry --write',
      });
    }
  }

  const defaultQueue = join(config.config.paths.queues, `${config.config.policies.defaultLane}.md`);
  if (!(await exists(join(cwd, defaultQueue)))) {
    safeFixes.push({
      title: `Create missing queue file for lane ${config.config.policies.defaultLane}`,
      detail: defaultQueue,
    });
  }

  const outcome = await loadProject({ cwd });
  if (outcome.ok) {
    const findings = runValidators({
      graph: outcome.graph,
      config: outcome.config,
      parsed: outcome.parsed,
      parseFindings: outcome.parsed.findings,
    });
    for (const finding of findings) {
      if (
        (finding.code === 'SHIPPED_SPRINT_IN_QUEUE' ||
          finding.code === 'CANCELLED_SPRINT_IN_QUEUE') &&
        finding.file &&
        finding.entityId
      ) {
        manualSuggestions.push({
          title: `Remove ${finding.entityId} from queue`,
          detail: `${finding.entityId} from ${finding.file}`,
        });
      }
    }
  }

  return { safeFixes, manualSuggestions };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return false;
    throw cause;
  }
}
