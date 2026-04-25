import { type Severity, SeveritySchema } from '@repokernel/core';
import { Command } from 'commander';
import { runDoctorCommand } from './commands/doctor.js';
import { runExplainCommand } from './commands/explain.js';
import { runFixCommand } from './commands/fix.js';
import { runInitCommand } from './commands/init.js';
import { runInspectCommand } from './commands/inspect.js';
import { runNextCommand } from './commands/next.js';
import { runOpenCommand } from './commands/open.js';
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
  readonly only?: string;
  readonly min?: string;
  readonly code?: string[];
  readonly entity?: string;
  readonly open?: boolean;
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

interface InitOptions {
  readonly example?: boolean;
}

interface DoctorOptions {
  readonly json?: boolean;
}

interface InspectOptions {
  readonly json?: boolean;
}

interface ExplainOptions {
  readonly json?: boolean;
}

interface FixOptions {
  readonly preview?: boolean;
  readonly json?: boolean;
}

function severityOrThrow(name: string, input: string | undefined): Severity | undefined {
  if (input === undefined) return undefined;
  const parsed = SeveritySchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`invalid ${name} value "${input}" (use P0|P1|P2|P3)`);
  }
  return parsed.data;
}

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name('repokernel')
    .description('Local-first, Git-native correctness engine for AI coding workflows.')
    .option('--cwd <path>', 'project root', process.cwd())
    .action(async (opts: GlobalOptions) => {
      const result = await runStatusCommand({ cwd: opts.cwd ?? process.cwd(), json: false });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('validate')
    .description('validate the project state')
    .option('--json', 'emit JSON output', false)
    .option('--fail-on <severity>', 'severity threshold (P0|P1|P2|P3)')
    .option('--only <severity>', 'show only one severity (P0|P1|P2|P3)')
    .option('--min <severity>', 'show findings at or above severity (P0|P1|P2|P3)')
    .option('--code <code>', 'show only a finding code; repeatable', collectOption, [])
    .option('--entity <id>', 'show only findings for an entity id')
    .option('--open', 'open the first displayed finding file', false)
    .action(async (opts: ValidateOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & ValidateOptions>();
      const cwd = globals.cwd ?? process.cwd();
      const failOn = severityOrThrow('--fail-on', opts.failOn);
      const only = severityOrThrow('--only', opts.only);
      const min = severityOrThrow('--min', opts.min);
      const result = await runValidateCommand({
        cwd,
        json: opts.json === true,
        open: opts.open === true,
        ...(failOn !== undefined ? { failOn } : {}),
        filters: {
          ...(only !== undefined ? { only } : {}),
          ...(min !== undefined ? { min } : {}),
          ...(opts.code !== undefined && opts.code.length > 0 ? { codes: opts.code } : {}),
          ...(opts.entity !== undefined ? { entity: opts.entity } : {}),
        },
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
    .command('doctor')
    .description('diagnose RepoKernel setup problems')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: DoctorOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & DoctorOptions>();
      const result = await runDoctorCommand({
        cwd: globals.cwd ?? process.cwd(),
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('init')
    .description('initialize RepoKernel project files')
    .option('--example', 'create a working starter project', false)
    .action(async (opts: InitOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & InitOptions>();
      const result = await runInitCommand({
        cwd: globals.cwd ?? process.cwd(),
        example: opts.example === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('inspect <id>')
    .description('show a human-readable entity view')
    .option('--json', 'emit JSON output', false)
    .action(async (id: string, opts: InspectOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & InspectOptions>();
      const result = await runInspectCommand({
        cwd: globals.cwd ?? process.cwd(),
        id,
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('explain <code>')
    .description('explain a validation code')
    .option('--json', 'emit JSON output', false)
    .action((code: string, opts: ExplainOptions) => {
      const result = runExplainCommand({ code, json: opts.json === true });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('open <id>')
    .description('open an entity source file')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runOpenCommand({ cwd: globals.cwd ?? process.cwd(), id });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('fix')
    .description('preview safe mechanical fixes')
    .option('--preview', 'show safe fixes without applying them', false)
    .option('--json', 'emit JSON output (requires --preview)', false)
    .action(async (opts: FixOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & FixOptions>();
      const result = await runFixCommand({
        cwd: globals.cwd ?? process.cwd(),
        preview: opts.preview === true,
        json: opts.json === true,
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
