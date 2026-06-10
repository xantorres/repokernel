import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import {
  type Config,
  compileRejectionPattern,
  findProjectRoot,
  isSafeRejectionPattern,
  loadConfig,
  loadProject,
  REJECTION_REGISTRY_SCHEMA_VERSION,
  RegistrySchema,
  RejectionRegistrySchema,
  RepoKernelError,
  toErrorMessage,
} from '@repokernel/core';
import { satisfies, validRange } from 'semver';
import { BUILTIN_PRESETS } from '../agents/catalog.js';
import { EXIT_FINDINGS, EXIT_OK } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { getPublishState, resolveCommitSha } from '../lifecycle/git.js';
import { git } from '../lifecycle/gitExec.js';
import { toolingExecFile } from '../security/spawnPolicy.js';
import { detectOperationalCorruption } from './recover.js';
import type { CommandResult } from './validate.js';

export interface DoctorCommandOptions {
  readonly cwd: string;
  readonly json?: boolean;
  readonly fix?: boolean;
  readonly runtimeVersion?: string;
  readonly agentEnv?: boolean;
}

interface DoctorProblem {
  readonly title: string;
  readonly expected?: string;
  readonly found?: string;
  readonly fix: readonly string[];
}

/**
 * Flag sprints whose recorded base_sha / end_sha no longer resolves to a commit
 * in this repository — a corrupt or hand-edited SHA silently produces a wrong
 * review diff, so surface it before it misleads a gate. Active sprints are
 * checked for base_sha; shipped sprints for base_sha and end_sha.
 */
async function sprintShaProblems(cwd: string): Promise<DoctorProblem[]> {
  const problems: DoctorProblem[] = [];
  const outcome = await loadProject({ cwd }).catch(() => null);
  if (!outcome || !outcome.ok) return problems;

  const reachable = new Map<string, boolean>();
  const isReachable = async (sha: string): Promise<boolean> => {
    // rk records full 40-char SHAs; treat anything shorter (example-scaffold
    // placeholders, abbreviations) as out of scope here rather than as noise.
    if (!/^[0-9a-f]{40}$/i.test(sha)) return true;
    const cached = reachable.get(sha);
    if (cached !== undefined) return cached;
    let ok = true;
    try {
      await resolveCommitSha(cwd, sha);
    } catch {
      ok = false;
    }
    reachable.set(sha, ok);
    return ok;
  };
  const flag = (sprintId: string, field: string, sha: string): void => {
    problems.push({
      title: `Sprint ${sprintId} ${field} is unreachable in git`,
      expected: 'a commit reachable from this repository',
      found: sha,
      fix: [
        `Confirm the recorded ${field} for ${sprintId}; re-run rk start to recapture base_sha or correct the sprint frontmatter.`,
      ],
    });
  };

  for (const sprint of outcome.graph.sprints.values()) {
    // base_sha is captured at start and relied on through review and close, so
    // check it for every in-flight or shipped sprint; end_sha exists only once shipped.
    const checksBaseSha =
      sprint.status === 'active' || sprint.status === 'review' || sprint.status === 'shipped';
    if (checksBaseSha && sprint.base_sha && !(await isReachable(sprint.base_sha))) {
      flag(sprint.id, 'base_sha', sprint.base_sha);
    }
    if (sprint.status === 'shipped' && sprint.end_sha && !(await isReachable(sprint.end_sha))) {
      flag(sprint.id, 'end_sha', sprint.end_sha);
    }
  }
  return problems;
}

export async function runDoctorCommand(opts: DoctorCommandOptions): Promise<CommandResult> {
  const startCwd = resolve(opts.cwd);
  const problems: DoctorProblem[] = [];

  const found = await findProjectRoot(startCwd);
  const cwd = found?.cwd ?? startCwd;

  const insideGit = await isInsideGitRepo(cwd);
  if (!insideGit) {
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

      // Binary self-check: when `automation.binary` is configured, compare
      // the running `rk` binary to the expected path. Catches the
      // multi-install case where `pnpm link --global` and an `npm i -g`
      // disagree on which `rk` is in PATH, or where an agent runs `rk` from
      // a stale dist/ inside a worktree. Skips silently when the config
      // field is unset (most projects).
      if (config.automation.binary !== undefined) {
        const expected = config.automation.binary;
        const resolvedBinary = await whichRk();
        if (resolvedBinary === null) {
          problems.push({
            title: 'rk binary not found on PATH',
            expected,
            fix: [
              `Install or link rk so that \`${process.platform === 'win32' ? 'where' : 'which'} rk\` resolves to ${expected}`,
            ],
          });
        } else if (!binariesMatch(expected, resolvedBinary)) {
          problems.push({
            title: 'rk binary does not match automation.binary',
            expected,
            found: resolvedBinary,
            fix: [
              `Update PATH so \`rk\` resolves to ${expected}, OR set automation.binary to ${JSON.stringify(resolvedBinary)} in repokernel.config.yaml if the new location is intentional.`,
            ],
          });
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

      if (insideGit) {
        for (const problem of await sprintShaProblems(cwd)) {
          problems.push(problem);
        }
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

      if (opts.agentEnv) {
        for (const problem of await runAgentEnvPreflight(cwd, config)) {
          problems.push(problem);
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
    const result = await git(['-C', cwd, 'rev-parse', '--is-inside-work-tree']);
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
        found: toErrorMessage(cause),
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
        found: toErrorMessage(cause),
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
    const { stdout } = await git(['-C', cwd, 'config', '--get', key]);
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
    // Built-in presets can carry a name that differs from the binary they
    // invoke (e.g. `codex-danger` runs the `codex` CLI), so check the real
    // command, not the preset name.
    const agentBinary = BUILTIN_PRESETS[configuredAgent]?.command ?? configuredAgent;
    if (!(await binaryOnPath(agentBinary))) {
      warnings.push({
        title: `agent binary "${agentBinary}" not found on PATH`,
        expected: `${agentBinary} executable`,
        fix: [
          `Install the ${agentBinary} CLI, or run with --agent fake to smoke-test`,
          'rk run -m "..." --agent fake',
        ],
      });
    }
  }

  if (
    (configuredAgent === 'codex' || configuredAgent === 'codex-danger') &&
    !process.env.OPENAI_API_KEY
  ) {
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

async function runAgentEnvPreflight(cwd: string, config: Config): Promise<DoctorProblem[]> {
  const warnings: DoctorProblem[] = [];
  warnings.push(...(await runEnvPreflight(config.automation.defaultAgent)));

  const packageJsonPath = join(cwd, 'package.json');
  const pkg = await readPackageJson(packageJsonPath);
  const packageManager = packageManagerFromPackageJson(pkg);
  const packageManagerBinary =
    packageManager?.split('@')[0] ?? (await detectPackageManagerFromLocks(cwd));

  if (packageManager !== undefined && packageManagerBinary !== undefined) {
    if (!isAllowedPackageManager(packageManagerBinary)) {
      warnings.push({
        title: `Unsupported package manager "${packageManagerBinary}"`,
        expected: 'packageManager is npm, pnpm, yarn, or bun',
        found: packageManager,
        fix: ['Use a supported package manager, or run its preflight manually.'],
      });
    } else if ((await execText(packageManagerBinary, ['--version'], cwd)) === null) {
      warnings.push({
        title: `package manager "${packageManagerBinary}" not found on PATH`,
        expected: packageManager,
        fix: [`Install ${packageManagerBinary}, or update packageManager in package.json.`],
      });
    }
  }

  if (!(await exists(join(cwd, 'node_modules')))) {
    warnings.push({
      title: 'Dependencies are not installed',
      expected: 'node_modules present',
      fix: [packageManagerBinary ? `${packageManagerBinary} install` : 'Install dependencies.'],
    });
  }

  if (packageManagerBinary === 'pnpm') {
    const ignoreScripts = await execText('pnpm', ['config', 'get', 'ignore-scripts'], cwd);
    if (ignoreScripts?.trim() === 'true') {
      warnings.push({
        title: 'pnpm ignore-scripts is enabled',
        expected: 'pnpm config get ignore-scripts -> false',
        found: 'true',
        fix: [
          'pnpm config set ignore-scripts false',
          'pnpm rebuild native dependencies after changing this setting.',
        ],
      });
    }
  }

  if (process.versions.node.length === 0) {
    warnings.push({
      title: 'Node.js runtime not detected',
      expected: 'node --version works',
      fix: ['Install Node.js and rerun rk doctor --agent-env.'],
    });
  }

  for (const dependency of nativeDependencyCandidates(pkg)) {
    const resolved = await execText(
      process.execPath,
      ['-e', `require.resolve(${JSON.stringify(dependency)})`],
      cwd,
    );
    if (resolved === null) {
      warnings.push({
        title: `Native/runtime dependency probe failed: ${dependency}`,
        expected: `${dependency} can be resolved from Node.js`,
        fix: [
          packageManagerBinary
            ? `${packageManagerBinary} rebuild ${dependency}`
            : `Rebuild or reinstall ${dependency}.`,
        ],
      });
    }
  }

  const publishState = await getPublishState(cwd);
  if (publishState.state === 'no_remote') {
    warnings.push({
      title: 'No git remote configured',
      expected: 'At least one remote for publish-aware close/ship state',
      fix: ['git remote add origin <url>'],
    });
  } else if (publishState.state === 'not_pushed') {
    warnings.push({
      title: 'Branch is not fully published',
      expected: 'HEAD has an upstream and no unpushed commits',
      found: publishState.upstream ?? 'no upstream branch',
      fix: ['git push -u origin HEAD'],
    });
  } else if (publishState.state === 'unknown') {
    warnings.push({
      title: 'Could not determine publish state',
      expected: 'git remote/upstream checks succeed',
      fix: ['Inspect git remotes and upstream branch configuration.'],
    });
  }

  return warnings;
}

async function readPackageJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function packageManagerFromPackageJson(pkg: Record<string, unknown> | null): string | undefined {
  const value = pkg?.packageManager;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function detectPackageManagerFromLocks(cwd: string): Promise<string | undefined> {
  if (await exists(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(join(cwd, 'yarn.lock'))) return 'yarn';
  if ((await exists(join(cwd, 'bun.lockb'))) || (await exists(join(cwd, 'bun.lock')))) {
    return 'bun';
  }
  if (await exists(join(cwd, 'package-lock.json'))) return 'npm';
  return undefined;
}

function isAllowedPackageManager(name: string): boolean {
  return name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun';
}

function nativeDependencyCandidates(pkg: Record<string, unknown> | null): string[] {
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = pkg?.[field];
    if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) continue;
    for (const name of Object.keys(deps)) {
      if (['better-sqlite3', 'sqlite3', 'sharp', 'esbuild'].includes(name)) names.add(name);
    }
  }
  return [...names].sort();
}

async function execText(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<string | null> {
  try {
    return (await toolingExecFile(command, args, { cwd })).stdout.trim();
  } catch {
    return null;
  }
}

async function hasGitUserEmail(): Promise<boolean> {
  try {
    const result = await git(['config', '--get', 'user.email']);
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function binaryOnPath(name: string): Promise<boolean> {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = await toolingExecFile(lookup, [name], { cwd: process.cwd() });
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the `rk` binary on PATH via `which` (POSIX) or `where` (Windows).
 * Returns the first hit (Windows' `where` can return multiple lines —
 * order reflects PATH precedence). Returns `null` when the binary is not
 * found at all.
 */
async function whichRk(): Promise<string | null> {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = await toolingExecFile(lookup, ['rk'], { cwd: process.cwd() });
    const first = result.stdout.split(/\r?\n/u)[0]?.trim();
    return first && first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

/**
 * Match the configured `automation.binary` against the resolved path. Two
 * cases:
 *
 *   1. The configured value contains a path separator → compare the
 *      resolved real-path against the expected absolute path. We use
 *      `realpath` here so that symlinks (common for `pnpm link --global`
 *      and Homebrew shims) match the underlying install rather than the
 *      shim location.
 *   2. The configured value is a bare name (no slash) → just confirm the
 *      resolved binary's basename matches.
 *
 * Best-effort: a realpath failure on either side falls back to a literal
 * comparison so the check never crashes on unusual filesystems.
 */
function binariesMatch(expected: string, resolved: string): boolean {
  const hasSep = /[\\/]/.test(expected);
  if (!hasSep) {
    const base = resolved.split(/[\\/]/u).pop() ?? resolved;
    const expBase = expected.split(/[\\/]/u).pop() ?? expected;
    return base === expBase;
  }
  return expected === resolved;
}
