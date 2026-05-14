import { execFile } from 'node:child_process';
import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  compileRejectionPattern,
  findProjectRoot,
  isSafeRejectionPattern,
  loadConfig,
  loadProject,
  REJECTION_REGISTRY_SCHEMA_VERSION,
  RegistrySchema,
  RejectionRegistrySchema,
  RepoKernelError,
} from '@repokernel/core';
import { satisfies, validRange } from 'semver';
import { EXIT_FINDINGS, EXIT_OK } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { detectOperationalCorruption } from './recover.js';
import type { CommandResult } from './validate.js';

const execFileAsync = promisify(execFile);

export interface DoctorCommandOptions {
  readonly cwd: string;
  readonly json?: boolean;
  readonly fix?: boolean;
  readonly runtimeVersion?: string;
}

interface DoctorProblem {
  readonly title: string;
  readonly expected?: string;
  readonly found?: string;
  readonly fix: readonly string[];
}

export async function runDoctorCommand(opts: DoctorCommandOptions): Promise<CommandResult> {
  const startCwd = resolve(opts.cwd);
  const problems: DoctorProblem[] = [];

  const found = await findProjectRoot(startCwd);
  const cwd = found?.cwd ?? startCwd;

  if (!(await isInsideGitRepo(cwd))) {
    problems.push({
      title: 'Not inside a git repository',
      expected: 'RepoKernel projects should live inside git.',
      fix: ['Initialize git or run RepoKernel from the repository root.'],
    });
  }

  const configPath = found?.configPath ?? join(cwd, 'repokernel.config.yaml');
  if (!(await exists(configPath))) {
    problems.push({
      title: 'Missing config file',
      expected: 'repokernel.config.yaml',
      fix: ['repokernel init'],
    });
  } else {
    const configResult = await loadConfig({ cwd });
    if (!configResult.ok) {
      problems.push({
        title: 'Invalid config file',
        expected: 'Valid schemaVersion 1 RepoKernel config',
        found: configResult.finding.message,
        fix: ['repokernel validate'],
      });
    } else {
      const config = configResult.config;

      if (opts.runtimeVersion && config.requires) {
        const range = config.requires;
        if (validRange(range) === null) {
          problems.push({
            title: 'Invalid requires: value in config',
            expected: 'A valid semver range expression, e.g. ">=1.0.0"',
            found: `"${range}"`,
            fix: ['Update requires: in repokernel.config.yaml to a valid semver range.'],
          });
        } else if (!satisfies(opts.runtimeVersion, range)) {
          problems.push({
            title: 'rk version does not meet requires: constraint',
            expected: `semver range "${range}"`,
            found: `rk ${opts.runtimeVersion}`,
            fix: [`upgrade rk to a version satisfying "${range}"`],
          });
        }
      }

      for (const [label, configured] of Object.entries(config.paths)) {
        if (configured === undefined) continue;
        const path = join(cwd, configured);
        if (!isInsideProject(cwd, path)) {
          problems.push({
            title: `Path escapes project root: ${label}`,
            expected: configured,
            found: path,
            fix: ['Update repokernel.config.yaml so the path stays inside this repository.'],
          });
          continue;
        }
        const shouldBeDirectory = label !== 'registry';
        const expectedPath = shouldBeDirectory ? configured : dirname(configured);
        if (!(await exists(join(cwd, expectedPath)))) {
          problems.push({
            title: `Missing ${label} path`,
            expected: expectedPath,
            fix: [`mkdir -p ${expectedPath}`],
          });
        }
      }

      const sprintFiles = await markdownFiles(join(cwd, config.paths.sprints));
      if (sprintFiles.length === 0) {
        problems.push({
          title: 'No sprint files found',
          expected: config.paths.sprints,
          fix: ['repokernel init --example', `Create a sprint under ${config.paths.sprints}`],
        });
        // First-run: surface env preflight warnings so the user fixes them
        // before their first `rk run`.
        for (const warning of await runEnvPreflight(config.automation.defaultAgent)) {
          problems.push(warning);
        }
      }

      const queueFiles = await markdownFiles(join(cwd, config.paths.queues));
      if (queueFiles.length === 0) {
        problems.push({
          title: 'No queue file found',
          expected: config.paths.queues,
          fix: [`Create ${join(config.paths.queues, `${config.policies.defaultLane}.md`)}`],
        });
      }

      const defaultQueue = join(cwd, config.paths.queues, `${config.policies.defaultLane}.md`);
      if (!(await exists(defaultQueue))) {
        problems.push({
          title: 'Default lane has no queue',
          expected: join(config.paths.queues, `${config.policies.defaultLane}.md`),
          fix: [`Create ${join(config.paths.queues, `${config.policies.defaultLane}.md`)}`],
        });
      }

      const registryPath = join(cwd, config.paths.registry);
      if (!(await exists(registryPath))) {
        problems.push({
          title: 'Missing registry file',
          expected: config.paths.registry,
          fix: ['repokernel registry --write'],
        });
      } else {
        try {
          const raw = JSON.parse(await readFile(registryPath, 'utf8')) as unknown;
          const parsed = RegistrySchema.safeParse(raw);
          if (!parsed.success) {
            problems.push({
              title: 'Invalid registry',
              expected: 'Schema-valid RepoKernel registry JSON',
              fix: ['repokernel registry --write'],
            });
          }
        } catch {
          problems.push({
            title: 'Invalid registry',
            expected: 'Readable JSON registry',
            fix: ['repokernel registry --write'],
          });
        }
      }

      for (const problem of await registryMergeDriverProblems(cwd, config.paths.registry)) {
        problems.push(problem);
      }

      for (const problem of await rejectionsProblems(cwd, config.paths.generated)) {
        problems.push(problem);
      }

      for (const file of config.generated.files) {
        const filePath = join(cwd, file);
        if (!(await exists(filePath))) {
          if (opts.fix) {
            await mkdir(dirname(filePath), { recursive: true });
          } else {
            problems.push({
              title: 'Generated file missing',
              expected: file,
              fix: ['Regenerate project outputs, then run repokernel validate.'],
            });
          }
        }
      }

      if (opts.fix) {
        const generatedDir = join(cwd, config.paths.generated);
        if (!(await exists(generatedDir))) {
          await mkdir(generatedDir, { recursive: true });
        }
      }
    }
  }

  // Operational corruption (worktrees.json / run files). Surfaced here so
  // operators see "your operational state is broken" alongside the
  // setup-level checks already in this command. Repair flow is `rk recover`.
  for (const finding of await detectOperationalCorruption(cwd)) {
    problems.push({
      title: `Corrupt operational state: ${finding.kind}`,
      expected: 'Parseable operational metadata',
      found: `${finding.path} — ${finding.detail}`,
      fix: ['rk recover --preview', 'rk recover --apply'],
    });
  }

  if (await isRepoKernelSourceTree(cwd)) {
    for (const file of ['packages/core/dist/index.js', 'packages/cli/dist/index.js']) {
      if (!(await exists(join(cwd, file)))) {
        problems.push({
          title: 'Package not built',
          expected: file,
          fix: ['pnpm build'],
        });
      }
    }
    const example = await validateBasicExample(cwd);
    if (example) problems.push(example);
  }

  return formatDoctor(problems, opts.json === true);
}

function formatDoctor(problems: readonly DoctorProblem[], json: boolean): CommandResult {
  const ok = problems.length === 0;
  const exitCode = ok ? EXIT_OK : EXIT_FINDINGS;

  if (json) {
    return {
      exitCode,
      stdout: `${emitJson({ schemaVersion: 1, ok, problems })}\n`,
      stderr: '',
    };
  }

  if (ok) {
    return {
      exitCode: EXIT_OK,
      stdout: `${['RepoKernel setup looks good.', '', 'Next:', '  rk validate', '  rk next'].join(
        '\n',
      )}\n`,
      stderr: '',
    };
  }

  const lines = ['RepoKernel setup is incomplete.', ''];
  problems.forEach((problem, index) => {
    lines.push(`${index + 1}. ${problem.title}`);
    if (problem.expected) lines.push(`   Expected: ${problem.expected}`);
    if (problem.found) lines.push(`   Found: ${problem.found}`);
    lines.push('', '   Fix:');
    for (const fix of problem.fix) lines.push(`   ${fix}`);
    if (index !== problems.length - 1) lines.push('');
  });
  return { exitCode: EXIT_FINDINGS, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

async function validateBasicExample(cwd: string): Promise<DoctorProblem | null> {
  const exampleCwd = join(cwd, 'examples/basic');
  if (!(await exists(join(exampleCwd, 'repokernel.config.yaml')))) {
    return {
      title: 'Examples not initialized',
      expected: 'examples/basic/repokernel.config.yaml',
      fix: ['Restore examples/basic or run tests from a complete checkout.'],
    };
  }
  try {
    const outcome = await loadProject({ cwd: exampleCwd });
    if (!outcome.ok) {
      return {
        title: 'Examples not initialized',
        expected: 'examples/basic should load cleanly',
        fix: ['Restore examples/basic fixtures.'],
      };
    }
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return {
        title: 'Examples not initialized',
        expected: 'examples/basic should load cleanly',
        found: cause.message,
        fix: ['Restore examples/basic fixtures.'],
      };
    }
    throw cause;
  }
  return null;
}

async function isInsideGitRepo(cwd: string): Promise<boolean> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree']);
    return result.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function isRepoKernelSourceTree(cwd: string): Promise<boolean> {
  return (
    (await exists(join(cwd, 'pnpm-workspace.yaml'))) &&
    (await exists(join(cwd, 'packages/core/package.json'))) &&
    (await exists(join(cwd, 'packages/cli/package.json')))
  );
}

async function markdownFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw new RepoKernelError('IO_ERROR', `cannot read ${dir}`, cause);
  }
}

function isInsideProject(cwd: string, path: string): boolean {
  const root = resolve(cwd);
  const target = resolve(path);
  return target === root || target.startsWith(`${root}${sep}`);
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

async function registryMergeDriverProblems(
  cwd: string,
  registryPath: string,
): Promise<DoctorProblem[]> {
  const problems: DoctorProblem[] = [];
  const driverName = 'repokernel-registry';
  const expectedDriverAttr = `merge=${driverName}`;
  const normalizedRegistry = posix.normalize(registryPath);
  const attributesPath = join(cwd, '.gitattributes');

  let attributes = '';
  try {
    attributes = await readFile(attributesPath, 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT')
      throw new RepoKernelError('IO_ERROR', `cannot read ${attributesPath}`, cause);
  }
  // Tokenise each non-comment .gitattributes line: <pattern> <attr>... .
  // The pattern must match the registry path after path normalization
  // (collapses ./ and trailing /); attrs must contain `merge=<driver>`.
  // A user can append `text eol=lf` or other attrs without a false-positive.
  const hasAttribute = attributes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .some((line) => {
      const tokens = line.split(/\s+/);
      const pattern = tokens[0];
      if (pattern === undefined) return false;
      if (posix.normalize(pattern) !== normalizedRegistry) return false;
      return tokens.slice(1).includes(expectedDriverAttr);
    });
  if (!hasAttribute) {
    problems.push({
      title: 'Registry merge driver attributes not installed',
      expected: `${normalizedRegistry} ${expectedDriverAttr}`,
      found: attributesPath,
      fix: ['Re-run `rk init` from this clone to install .gitattributes wiring.'],
    });
  }

  const configChecks = [
    {
      key: `merge.${driverName}.driver`,
      expected: 'rk registry-merge-driver --current %A --other %B --base %O',
    },
    { key: `merge.${driverName}.name`, expected: 'RepoKernel registry merge driver' },
    { key: `merge.${driverName}.recursive`, expected: 'binary' },
  ];

  for (const check of configChecks) {
    const found = await gitConfigGet(cwd, check.key);
    if (found !== check.expected) {
      problems.push({
        title: `Registry merge driver git config missing: ${check.key}`,
        expected: check.expected,
        found: found ?? '<missing>',
        fix: ['Re-run `rk init` in this clone; git merge-driver config is local to each clone.'],
      });
    }
  }

  return problems;
}

async function rejectionsProblems(cwd: string, generatedDir: string): Promise<DoctorProblem[]> {
  const path = join(cwd, generatedDir, 'rejections.json');
  if (!(await exists(path))) return [];
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    return [
      {
        title: 'Cannot read rejections file',
        expected: path,
        found: (cause as Error).message,
        fix: ['Restore the file from git, or `rm` it to start fresh.'],
      },
    ];
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    return [
      {
        title: 'Invalid rejections file (JSON parse)',
        expected: 'Parseable JSON',
        found: (cause as Error).message,
        fix: ['Hand-edit to valid JSON, or `rm` the file to start fresh.'],
      },
    ];
  }
  const parsed = RejectionRegistrySchema.safeParse(json);
  if (!parsed.success) {
    return [
      {
        title: 'Invalid rejections file (schema)',
        expected: `schemaVersion ${REJECTION_REGISTRY_SCHEMA_VERSION} RejectionRegistry`,
        found: parsed.error.message,
        fix: ['Repair the file by hand, or `rm` it to start fresh.'],
      },
    ];
  }
  const problems: DoctorProblem[] = [];
  for (const adr of parsed.data.rejections) {
    if (compileRejectionPattern(adr.pattern) === null) {
      problems.push({
        title: `Rejection ${adr.id} has a malformed regex pattern`,
        expected: 'Pattern compiles as a JavaScript RegExp',
        found: adr.pattern,
        fix: [`Edit ${path} and fix the pattern, or remove the entry.`],
      });
    } else if (!isSafeRejectionPattern(adr.pattern)) {
      problems.push({
        title: `Rejection ${adr.id} has an unsafe regex pattern`,
        expected: 'Pattern is safe for tracker title/body matching',
        found: adr.pattern,
        fix: [`Edit ${path} to simplify the pattern, or remove the entry.`],
      });
    }
  }
  return problems;
}

async function gitConfigGet(cwd: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'config', '--get', key]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Environment preflight checks for first-run users. All warnings — never block.
 * Surfaces missing dev-env basics so the user fixes them before their first
 * `rk run`. No network calls.
 */
export async function runEnvPreflight(configuredAgent: string): Promise<DoctorProblem[]> {
  const warnings: DoctorProblem[] = [];

  if (!(await hasGitUserEmail())) {
    warnings.push({
      title: 'git user.email is not configured',
      expected: 'git config user.email set',
      fix: [
        'git config --global user.email "you@example.com"',
        'git config --global user.name "Your Name"',
      ],
    });
  }

  if (!process.env.EDITOR && !process.env.VISUAL) {
    warnings.push({
      title: '$EDITOR or $VISUAL is not set',
      expected: 'EDITOR or VISUAL env var',
      fix: [
        'export EDITOR=vim     # or your editor of choice',
        '`rk run` falls back to a default editor; setting one yourself avoids surprises',
      ],
    });
  }

  if (configuredAgent !== 'manual' && configuredAgent !== 'fake') {
    if (!(await binaryOnPath(configuredAgent))) {
      warnings.push({
        title: `agent binary "${configuredAgent}" not found on PATH`,
        expected: `${configuredAgent} executable`,
        fix: [
          `Install the ${configuredAgent} CLI, or run with --agent fake to smoke-test`,
          'rk run -m "..." --agent fake',
        ],
      });
    }
  }

  if (configuredAgent === 'codex' && !process.env.OPENAI_API_KEY) {
    warnings.push({
      title: 'OPENAI_API_KEY is not set',
      expected: 'env var OPENAI_API_KEY (only if codex CLI does not have its own login)',
      fix: ['export OPENAI_API_KEY=sk-...     # ignore if codex is already logged in'],
    });
  }

  if (configuredAgent === 'ollama' && !process.env.OLLAMA_HOST) {
    warnings.push({
      title: 'OLLAMA_HOST is not set',
      expected: 'env var OLLAMA_HOST (defaults to http://localhost:11434 if unset)',
      fix: ['export OLLAMA_HOST=http://localhost:11434'],
    });
  }

  return warnings;
}

async function hasGitUserEmail(): Promise<boolean> {
  try {
    const result = await execFileAsync('git', ['config', '--get', 'user.email']);
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function binaryOnPath(name: string): Promise<boolean> {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = await execFileAsync(lookup, [name]);
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
