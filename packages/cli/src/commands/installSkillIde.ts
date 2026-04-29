import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from '../exitCodes.js';
import type { CommandResult } from './validate.js';

export type IdeTarget = 'cursor' | 'windsurf' | 'copilot' | 'gemini' | 'opencode';

export interface InstallSkillIdeOptions {
  readonly ide: IdeTarget;
  readonly project: boolean;
  readonly cwd: string;
  readonly skillSourceDir: string;
  readonly dryRun: boolean;
  readonly force: boolean;
}

const COPILOT_MARKER_START = '<!-- repokernel:start -->';
const COPILOT_MARKER_END = '<!-- repokernel:end -->';

export function resolveIdePath(ide: IdeTarget, project: boolean, cwd: string): string {
  switch (ide) {
    case 'cursor':
      return project
        ? join(cwd, '.cursor', 'rules', 'repokernel.mdc')
        : join(homedir(), '.cursor', 'rules', 'repokernel.mdc');
    case 'windsurf':
      return project
        ? join(cwd, '.windsurf', 'rules', 'repokernel.md')
        : join(homedir(), '.windsurf', 'rules', 'repokernel.md');
    case 'copilot':
      return join(cwd, '.github', 'copilot-instructions.md');
    case 'gemini':
      return project ? join(cwd, 'GEMINI.md') : join(homedir(), '.gemini', 'GEMINI.md');
    case 'opencode':
      return project
        ? join(cwd, '.opencode', 'instructions.md')
        : join(homedir(), '.config', 'opencode', 'instructions.md');
  }
}

export async function readSkillContent(skillSourceDir: string): Promise<string> {
  const skillPath = join(skillSourceDir, 'skills', 'repokernel', 'SKILL.md');
  let raw: string;
  try {
    raw = await readFile(skillPath, 'utf8');
  } catch (cause) {
    throw new Error(`cannot read skill source at ${skillPath}: ${(cause as Error).message}`);
  }
  return stripFrontmatter(raw);
}

export function buildIdeFile(ide: IdeTarget, skillContent: string): string {
  switch (ide) {
    case 'cursor':
      return [
        '---',
        'description: RepoKernel operator — route rk commands to the CLI',
        'alwaysApply: false',
        '---',
        '',
        skillContent.trimEnd(),
        '',
      ].join('\n');
    case 'windsurf':
      return `${skillContent.trimEnd()}\n`;
    case 'copilot':
    case 'gemini':
    case 'opencode':
      return `${COPILOT_MARKER_START}\n${skillContent.trimEnd()}\n${COPILOT_MARKER_END}\n`;
  }
}

export async function runInstallSkillIdeCommand(
  opts: InstallSkillIdeOptions,
): Promise<CommandResult> {
  const VALID_IDES: readonly IdeTarget[] = ['cursor', 'windsurf', 'copilot', 'gemini', 'opencode'];
  if (!VALID_IDES.includes(opts.ide)) {
    return {
      exitCode: EXIT_USAGE,
      stdout: '',
      stderr: `unknown --ide value "${opts.ide as string}". Valid: ${VALID_IDES.join(', ')}\n`,
    };
  }

  let skillContent: string;
  try {
    skillContent = await readSkillContent(opts.skillSourceDir);
  } catch (cause) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `${(cause as Error).message}\n`,
    };
  }

  const outputPath = resolveIdePath(opts.ide, opts.project, opts.cwd);
  const fileContent = buildIdeFile(opts.ide, skillContent);

  if (opts.dryRun) {
    return {
      exitCode: EXIT_OK,
      stdout: `Would write: ${outputPath}\n`,
      stderr: '',
    };
  }

  try {
    const action = await applyIdeFile(outputPath, opts.ide, fileContent, opts.force);
    return {
      exitCode: EXIT_OK,
      stdout: buildSuccessMessage(opts.ide, outputPath, action),
      stderr: '',
    };
  } catch (cause) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `install failed: ${(cause as Error).message}\n`,
    };
  }
}

async function applyIdeFile(
  path: string,
  ide: IdeTarget,
  content: string,
  force: boolean,
): Promise<'created' | 'updated' | 'unchanged'> {
  await mkdir(dirname(path), { recursive: true });

  if (ide === 'copilot' || ide === 'gemini' || ide === 'opencode') {
    return applyCopilotFile(path, content);
  }

  const existing = await readFileSafe(path);
  if (existing !== null) {
    if (existing === content) return 'unchanged';
    if (!force) {
      throw new Error(`${path} already exists and differs. Re-run with --force to overwrite.`);
    }
    await writeFile(path, content, 'utf8');
    return 'updated';
  }

  await writeFile(path, content, 'utf8');
  return 'created';
}

async function applyCopilotFile(
  path: string,
  markedContent: string,
): Promise<'created' | 'updated' | 'unchanged'> {
  const existing = await readFileSafe(path);

  if (existing === null) {
    await writeFile(path, markedContent, 'utf8');
    return 'created';
  }

  const startIdx = existing.indexOf(COPILOT_MARKER_START);
  const endIdx = existing.indexOf(COPILOT_MARKER_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + COPILOT_MARKER_END.length);
    const updated = `${before}${markedContent}${after.startsWith('\n') ? after : `\n${after}`}`;
    if (updated === existing) return 'unchanged';
    await writeFile(path, updated, 'utf8');
    return 'updated';
  }

  const separator = existing.endsWith('\n') ? '' : '\n';
  await writeFile(path, `${existing}${separator}\n${markedContent}`, 'utf8');
  return 'updated';
}

function buildSuccessMessage(
  ide: IdeTarget,
  path: string,
  action: 'created' | 'updated' | 'unchanged',
): string {
  const lines: string[] = [];
  if (action === 'unchanged') {
    lines.push(`RepoKernel ${ide} adapter already up to date at ${path}`);
  } else {
    lines.push(`${action === 'created' ? 'Created' : 'Updated'} ${path}`);
    lines.push('');
    lines.push(ideNextSteps(ide));
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function ideNextSteps(ide: IdeTarget): string {
  switch (ide) {
    case 'cursor':
      return 'Reload Cursor to activate the rule, then use @repokernel to invoke it.';
    case 'windsurf':
      return 'Reload Windsurf to activate the rule.';
    case 'copilot':
      return 'The RepoKernel operator instructions are now in .github/copilot-instructions.md.';
    case 'gemini':
      return 'RepoKernel instructions added to GEMINI.md. Gemini CLI will pick them up automatically.';
    case 'opencode':
      return 'RepoKernel instructions added. Reload opencode to activate.';
  }
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return content;
  return content.slice(end + 4).replace(/^\n/, '');
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    await stat(path);
    return await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
    throw cause;
  }
}
