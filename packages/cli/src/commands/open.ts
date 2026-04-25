import { loadProject, RepoKernelError } from '@repokernel/core';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { findEntity } from '../ux/entities.js';
import { openPathInEditor } from '../ux/open.js';
import type { CommandResult } from './validate.js';

export interface OpenCommandOptions {
  readonly cwd: string;
  readonly id: string;
}

export async function runOpenCommand(opts: OpenCommandOptions): Promise<CommandResult> {
  try {
    const outcome = await loadProject({ cwd: opts.cwd });
    if (!outcome.ok) {
      return {
        exitCode: EXIT_FINDINGS,
        stdout: '',
        stderr: 'project config is invalid; run repokernel validate\n',
      };
    }

    const entity = findEntity(outcome, opts.id);
    if (!entity) {
      return entityNotFound(opts.id);
    }
    if (!entity.file) {
      return {
        exitCode: EXIT_FINDINGS,
        stdout: `${entity.type} ${entity.id} has no source file\n\nTry:\n  repokernel status\n  repokernel validate\n`,
        stderr: '',
      };
    }
    const opened = await openPathInEditor(outcome.cwd, entity.file);
    return { exitCode: EXIT_OK, stdout: `${opened.message}\n`, stderr: '' };
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
}

function entityNotFound(id: string): CommandResult {
  return {
    exitCode: EXIT_FINDINGS,
    stdout: `entity not found: ${id}\n\nTry:\n  repokernel status\n  repokernel validate\n`,
    stderr: '',
  };
}
