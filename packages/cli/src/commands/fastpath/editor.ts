import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoKernelError } from '@repokernel/core';
import type { TaskInput, TaskSource } from './types.js';

const TEMPLATE = `# What should the agent do? (required)


# Acceptance criteria (optional, one per line)


# Constraints / forbidden paths (optional, one per line)


# Lines starting with # are ignored. Save and close to run, leave empty to abort.
`;

/**
 * Parse the structured editor template into a TaskInput.
 *
 * The template uses three `# Section heading` markers as separators:
 *   1. body
 *   2. acceptance criteria
 *   3. constraints
 *
 * Within each section any `#`-prefixed line is ignored (comments). Blank lines
 * separate criteria/constraints into entries.
 *
 * Returns null when the body section is empty — the caller should abort.
 */
export function parseEditorTemplate(raw: string, source: TaskSource): TaskInput | null {
  const lines = raw.split(/\r?\n/);

  type Section = 'body' | 'criteria' | 'constraints';
  const buckets: Record<Section, string[]> = {
    body: [],
    criteria: [],
    constraints: [],
  };
  let current: Section = 'body';

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#')) {
      // Section transitions are detected by keyword in the heading.
      const lower = trimmed.toLowerCase();
      if (lower.includes('acceptance criteria')) current = 'criteria';
      else if (lower.includes('constraints') || lower.includes('forbidden'))
        current = 'constraints';
      else if (lower.includes('what should the agent do')) current = 'body';
      // Comment line — never contributes content.
      continue;
    }
    buckets[current].push(line);
  }

  const body = buckets.body.join('\n').trim();
  if (body.length === 0) return null;

  const criteriaLines = buckets.criteria
    .map((l) => stripBullet(l).trim())
    .filter((l) => l.length > 0);
  const constraintLines = buckets.constraints
    .map((l) => stripBullet(l).trim())
    .filter((l) => l.length > 0);

  return {
    body,
    acceptanceCriteria: criteriaLines,
    constraints: constraintLines,
    source,
  };
}

function stripBullet(line: string): string {
  return line.replace(/^\s*[-*]\s+/, '');
}

/**
 * Resolve which editor command to invoke. Order matches the plan:
 *   $RK_EDITOR > $VISUAL > $EDITOR > code --wait > nvim > vi
 *
 * Returns the command split into argv pieces ready for execFile.
 */
export function resolveEditorCommand(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const candidates = [env.RK_EDITOR, env.VISUAL, env.EDITOR];
  for (const c of candidates) {
    if (c && c.trim().length > 0) return splitShellish(c.trim());
  }
  // Fallbacks ordered most→least common in modern setups.
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return ['vi'];
  }
  return ['notepad'];
}

function splitShellish(cmd: string): readonly string[] {
  // Conservative: split on whitespace. Quoted args aren't supported, but the
  // common cases (`code --wait`, `nvim`, `vi`) all work without quoting.
  return cmd.split(/\s+/u).filter((p) => p.length > 0);
}

/**
 * Open the user's editor on a fresh template, wait for save+close, return the
 * parsed TaskInput. Returns null when the user saved an empty body (intent: abort).
 *
 * Throws RepoKernelError when the editor cannot be launched.
 */
export async function captureTaskFromEditor(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TaskInput | null> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'rk-task-'));
  const tmpFile = join(tmpDir, 'TASK_EDITMSG.md');
  try {
    await writeFile(tmpFile, TEMPLATE, 'utf8');

    const argv = resolveEditorCommand(env);
    const [cmd, ...args] = argv;
    if (cmd === undefined) {
      throw new RepoKernelError('IO_ERROR', 'no editor configured (set $EDITOR)');
    }

    await runEditor(cmd, [...args, tmpFile]);

    const raw = await readFile(tmpFile, 'utf8');
    return parseEditorTemplate(raw, 'editor');
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => null);
  }
}

function runEditor(cmd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolveEditor, rejectEditor) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', (cause) => {
      rejectEditor(
        new RepoKernelError(
          'IO_ERROR',
          `editor "${cmd}" could not be launched — set $EDITOR to a working command`,
          cause,
        ),
      );
    });
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveEditor();
        return;
      }
      rejectEditor(
        new RepoKernelError(
          'IO_ERROR',
          `editor "${cmd}" exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
        ),
      );
    });
  });
}
