import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { EXIT_BLOCKED, EXIT_OK, EXIT_USAGE } from '../exitCodes.js';
import { renderCommandShell, renderProtocolShell } from '../lib/commandShellTemplate.js';
import type { CommandResult } from './validate.js';

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const DEFAULT_COMMANDS_DIR = '.claude/commands';
const DEFAULT_PROTOCOL_DIR = '.agents/protocol';

export interface ScaffoldCommandOptions {
  readonly cwd: string;
  readonly description?: string;
  readonly argHint?: string;
  readonly tier?: string;
  readonly withProtocol?: boolean;
  readonly commandsDir?: string;
  readonly protocolDir?: string;
  readonly force?: boolean;
  readonly json?: boolean;
}

function err(message: string, exitCode: number = EXIT_BLOCKED): CommandResult {
  return { exitCode, stdout: '', stderr: `${message}\n` };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

export async function runScaffoldCommandCommand(
  name: string,
  opts: ScaffoldCommandOptions,
): Promise<CommandResult> {
  if (name.length === 0) {
    return err('command name is required', EXIT_USAGE);
  }
  if (!NAME_RE.test(name)) {
    return err(
      `invalid command name "${name}" (use kebab-case: lowercase letters, digits, hyphens)`,
      EXIT_USAGE,
    );
  }

  const cwd = resolve(opts.cwd);
  const commandsDir = opts.commandsDir ?? DEFAULT_COMMANDS_DIR;
  const protocolDir = opts.protocolDir ?? DEFAULT_PROTOCOL_DIR;
  const tier = opts.tier ?? 'orchestrate';
  const description = opts.description ?? `TODO: describe ${name}`;
  const argHint = opts.argHint ?? '';

  const commandPathAbs = join(cwd, commandsDir, `${name}.md`);
  const protocolPathAbs = join(cwd, protocolDir, `${name}.md`);
  const commandPathRel = toPosix(relative(cwd, commandPathAbs));
  const protocolPathRel = toPosix(relative(cwd, protocolPathAbs));

  if (!opts.force) {
    if (await exists(commandPathAbs)) {
      return err(`${commandPathRel} already exists; pass --force to overwrite`);
    }
    if (opts.withProtocol === true && (await exists(protocolPathAbs))) {
      return err(`${protocolPathRel} already exists; pass --force to overwrite`);
    }
  }

  // Use a posix-style relative path inside the command body so it renders
  // identically on Windows and *nix.
  const protocolBodyPath = posix.join(protocolDir, `${name}.md`);

  const commandContent = renderCommandShell({
    name,
    description,
    argHint,
    tier,
    protocolPath: protocolBodyPath,
  });

  const created: string[] = [];

  await mkdir(dirname(commandPathAbs), { recursive: true });
  await writeFile(commandPathAbs, commandContent, 'utf8');
  created.push(commandPathRel);

  if (opts.withProtocol === true) {
    const protocolContent = renderProtocolShell({ name });
    await mkdir(dirname(protocolPathAbs), { recursive: true });
    await writeFile(protocolPathAbs, protocolContent, 'utf8');
    created.push(protocolPathRel);
  }

  if (opts.json === true) {
    const payload = {
      created,
      command_path: commandPathRel,
      protocol_path: opts.withProtocol === true ? protocolPathRel : null,
      tier,
    };
    return { exitCode: EXIT_OK, stdout: `${JSON.stringify(payload, null, 2)}\n`, stderr: '' };
  }

  const lines = [`Scaffolded ${created.length} file(s):`];
  for (const path of created) {
    lines.push(`  - ${path}`);
  }
  lines.push('');
  lines.push(`Next:`);
  lines.push(
    `  - Set the model field in ${commandPathRel} per your harness's tier-${tier} routing`,
  );
  if (opts.withProtocol === true) {
    lines.push(`  - Fill the TODO sections in ${protocolPathRel}`);
  } else {
    lines.push(`  - Author ${protocolPathRel} (or pass --with-protocol next time)`);
  }
  lines.push(`  - See docs/recipes/protocol-layer.md for the canonical pattern`);

  return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
}
