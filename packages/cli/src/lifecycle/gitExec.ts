import { toolingExecFile } from '../security/spawnPolicy.js';

/**
 * Run a `git` subprocess through the spawn-policy tooling chokepoint. Drops
 * the full `process.env`, forwarding only the default allowlist plus the
 * GIT_TOOLING_ENV_ALLOWLIST (author/committer identity, GIT_*_DATE, etc.).
 * Sets GIT_CONFIG_NOSYSTEM=1, GIT_OPTIONAL_LOCKS=0, GIT_TERMINAL_PROMPT=0 so
 * a hostile repo's system/global git config or fsmonitor cannot leak parent
 * secrets into hooks fired during `git commit` / `git checkout` / etc.
 *
 * `cwd` is inferred from a `-C <path>` flag in `args` when not passed
 * explicitly, so call sites stay close to the original `execFileAsync` shape.
 */
/**
 * Pre-subcommand global flags forced on every internal git invocation.
 * `core.hooksPath` is pointed at a path that cannot contain hook files, so
 * a hostile repo that sets `core.hooksPath = .githooks` in its tracked
 * `.git/config` (which `GIT_CONFIG_NOSYSTEM` does NOT neutralize — that
 * only blocks /etc/gitconfig) cannot execute a tree-shipped hook when rk
 * runs `git commit` / `git checkout` for its own metadata commits.
 */
const GIT_HOOKLESS_FLAGS: readonly string[] =
  process.platform === 'win32' ? ['-c', 'core.hooksPath=NUL'] : ['-c', 'core.hooksPath=/dev/null'];

export function git(
  args: readonly string[],
  cwd?: string,
  opts?: { readonly maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  const resolvedCwd = cwd ?? extractMinusC(args) ?? process.cwd();
  return toolingExecFile('git', [...GIT_HOOKLESS_FLAGS, ...args], {
    cwd: resolvedCwd,
    ...(opts?.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
  });
}

function extractMinusC(args: readonly string[]): string | undefined {
  const idx = args.indexOf('-C');
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

/**
 * `gh` calls need `GH_TOKEN` and a small set of `GITHUB_*` vars to function.
 * They are explicitly listed here rather than dropped silently — operators
 * who run `gh` outside the chokepoint can compare against this list to know
 * what their gh setup expects.
 */
const GH_TOOLING_EXTRA_ENV = [
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
] as const;

export function gh(
  args: readonly string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  const resolvedCwd = cwd ?? process.cwd();
  return toolingExecFile('gh', args, {
    cwd: resolvedCwd,
    extraEnv: GH_TOOLING_EXTRA_ENV,
  });
}
