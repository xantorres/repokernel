import type { Command } from 'commander';
import { EXIT_USAGE } from '../exitCodes.js';
import { exitWithResult, startCwdFor } from '../util/cli.js';
import { resolveProjectCwd } from '../util/program.js';

const VALID_SCOPES = ['checks_cmd', 'agent', 'env_passthrough'] as const;
type Scope = (typeof VALID_SCOPES)[number];

function isScope(s: string): s is Scope {
  return (VALID_SCOPES as readonly string[]).includes(s);
}

/**
 * Register the `rk trust` command group. Subcommands manage the user-local
 * trust file at ~/.repokernel/trust.yaml (or REPOKERNEL_TRUST_FILE). Repo
 * config that requests privileged actions (custom checksCmd, envPassthrough,
 * reviewer command) is rejected at runtime unless mirrored in this file.
 */
export function registerTrustCommands(program: Command): void {
  const trust = program
    .command('trust')
    .description('manage user-local trust grants for repokernel repos');

  trust
    .command('list')
    .description('show current trust grants from the user-local trust file')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: { json: boolean }) => {
      const { runTrustListCommand } = await import('../commands/trust.js');
      const result = await runTrustListCommand({ json: opts.json === true });
      await exitWithResult(result);
    });

  trust
    .command('audit [path]')
    .description('emit the trust YAML fragment needed to reproduce current repo behavior')
    .option('--apply', 'write the fragment into the user-local trust file', false)
    .option('--json', 'emit JSON output', false)
    .action(async (path: string | undefined, opts: { apply: boolean; json: boolean }, cmd) => {
      const { runTrustAuditCommand } = await import('../commands/trust.js');
      const cwd = path ? path : resolveProjectCwd(startCwdFor(cmd));
      const result = await runTrustAuditCommand({
        cwd,
        apply: opts.apply === true,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  trust
    .command('check')
    .description('check whether the current repo has all needed trust grants (exit 1 if missing)')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: { json: boolean }, cmd) => {
      const { runTrustCheckCommand } = await import('../commands/trust.js');
      const result = await runTrustCheckCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  trust
    .command('grant <scope> [key]')
    .description('grant a scope (checks_cmd | agent <name> | env_passthrough <name>)')
    .action(async (scope: string, key: string | undefined, _opts, cmd) => {
      if (!isScope(scope)) {
        await exitWithResult({
          exitCode: EXIT_USAGE,
          stdout: '',
          stderr: `unknown scope '${scope}'. Valid scopes: ${VALID_SCOPES.join(', ')}\n`,
        });
        return;
      }
      const { runTrustGrantCommand } = await import('../commands/trust.js');
      const result = await runTrustGrantCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        scope,
        ...(key !== undefined ? { key } : {}),
      });
      await exitWithResult(result);
    });

  trust
    .command('revoke <scope> [key]')
    .description('revoke a previously-granted scope')
    .action(async (scope: string, key: string | undefined, _opts, cmd) => {
      if (!isScope(scope)) {
        await exitWithResult({
          exitCode: EXIT_USAGE,
          stdout: '',
          stderr: `unknown scope '${scope}'. Valid scopes: ${VALID_SCOPES.join(', ')}\n`,
        });
        return;
      }
      const { runTrustRevokeCommand } = await import('../commands/trust.js');
      const result = await runTrustRevokeCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        scope,
        ...(key !== undefined ? { key } : {}),
      });
      await exitWithResult(result);
    });
}
