/**
 * Detection of who owns the execution environment a RepoKernel command runs in.
 *
 * `rk start` in `auto` mode acquires an isolated worktree only when RepoKernel
 * itself owns the environment. When an external coding agent or editor already
 * owns it — and, typically, the git checkout — acquiring a second worktree
 * underneath that tool is more confusing than helpful, so `auto` stays
 * metadata-only.
 *
 * Detection is best-effort: it sniffs environment-variable markers third-party
 * tools set. `--worktree` / `--no-worktree` and `start.worktree: always|never`
 * are the explicit overrides for when it guesses wrong.
 */

/** Exact environment-variable names set by external agents/editors. */
const EXACT_AGENT_ENV_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'] as const;

/** Environment-variable name prefixes set by external agents/editors. */
const PREFIX_AGENT_ENV_MARKERS = ['CURSOR_', 'CODEX_'] as const;

/**
 * True when the current process appears to run inside an external coding agent
 * or editor that owns the execution environment.
 */
export function isExternalAgentEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  for (const marker of EXACT_AGENT_ENV_MARKERS) {
    const value = env[marker];
    if (value !== undefined && value.length > 0) return true;
  }
  for (const key of Object.keys(env)) {
    if (!PREFIX_AGENT_ENV_MARKERS.some((prefix) => key.startsWith(prefix))) continue;
    const value = env[key];
    if (value !== undefined && value.length > 0) return true;
  }
  if (env.TERM_PROGRAM === 'vscode') return true;
  return false;
}
