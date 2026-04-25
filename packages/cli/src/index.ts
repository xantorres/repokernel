import { type Severity, SeveritySchema } from '@repokernel/core';
import { Command } from 'commander';
import { runNextCommand } from './commands/next.js';
import { runRegistryCommand } from './commands/registry.js';
import { runStatusCommand } from './commands/status.js';
import { runValidateCommand } from './commands/validate.js';
import { EXIT_RUNTIME } from './exitCodes.js';

interface GlobalOptions {
  readonly cwd?: string;
}

interface ValidateOptions {
  readonly json?: boolean;
  readonly failOn?: string;
}

interface RegistryOptions {
  readonly json?: boolean;
  readonly write?: boolean;
  readonly check?: boolean;
}

interface StatusOptions {
  readonly json?: boolean;
}

interface NextOptions {
  readonly json?: boolean;
  readonly lane?: string;
}

function severityOrThrow(input: string | undefined, fallback: Severity): Severity {
  if (input === undefined) return fallback;
  const parsed = SeveritySchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`invalid --fail-on value "${input}" (use P0|P1|P2|P3)`);
  }
  return parsed.data;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name('repokernel')
    .description('Local-first, Git-native correctness engine for AI coding workflows.')
    .option('--cwd <path>', 'project root', process.cwd());

  program
    .command('validate')
    .description('validate the project state')
    .option('--json', 'emit JSON output', false)
    .option('--fail-on <severity>', 'severity threshold (P0|P1|P2|P3)', 'P1')
    .action(async (opts: ValidateOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & ValidateOptions>();
      const cwd = globals.cwd ?? process.cwd();
      const failOn = severityOrThrow(opts.failOn, 'P1');
      const result = await runValidateCommand({
        cwd,
        json: opts.json === true,
        failOn,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('status')
    .description('summarize project health and next runnable sprint')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: StatusOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & StatusOptions>();
      const cwd = globals.cwd ?? process.cwd();
      const result = await runStatusCommand({ cwd, json: opts.json === true });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('next')
    .description('resolve the next runnable sprint')
    .option('--json', 'emit JSON output', false)
    .option('--lane <lane>', 'lane name (defaults to policies.defaultLane)')
    .action(async (opts: NextOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & NextOptions>();
      const cwd = globals.cwd ?? process.cwd();
      const result = await runNextCommand({
        cwd,
        json: opts.json === true,
        ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('registry')
    .description('generate, write, or check the project registry')
    .option('--json', 'emit JSON output', false)
    .option('--write', 'write the registry file', false)
    .option('--check', 'check the registry file for drift', false)
    .action(async (opts: RegistryOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & RegistryOptions>();
      const cwd = globals.cwd ?? process.cwd();
      const result = await runRegistryCommand({
        cwd,
        write: opts.write === true,
        check: opts.check === true,
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  return program;
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = createProgram();
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(EXIT_RUNTIME);
  }
}

const isEntry = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const url = new URL(`file://${argv1}`).href;
    // import.meta.url comparison (ESM)
    return url === (import.meta as { url?: string }).url;
  } catch {
    return false;
  }
})();

if (isEntry) {
  void main(process.argv.slice(2));
}
