import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadProject, RepoKernelError, runValidators } from '@repokernel/core';
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from '../exitCodes.js';
import { emitJson, jsonOk } from '../format/json.js';
import { fingerprintFinding, warningBaselinePath } from '../lifecycle/warningBaseline.js';
import type { CommandResult } from './validate.js';

export interface WarningsBaselineOptions {
  readonly cwd: string;
  readonly write: boolean;
  readonly owner?: string;
  readonly expires?: string;
  readonly json?: boolean;
}

export async function runWarningsBaselineCommand(
  opts: WarningsBaselineOptions,
): Promise<CommandResult> {
  if (opts.write && (!opts.owner || !opts.expires)) {
    return {
      exitCode: EXIT_USAGE,
      stdout: '',
      stderr: '--write requires --owner <name> and --expires <yyyy-mm-dd>\n',
    };
  }
  if (opts.expires !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(opts.expires)) {
    return { exitCode: EXIT_USAGE, stdout: '', stderr: '--expires must be yyyy-mm-dd\n' };
  }
  const cwd = resolve(opts.cwd);
  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: 'project failed to load\n' };
    }
    const findings = runValidators({
      graph: outcome.graph,
      config: outcome.config,
      parsed: outcome.parsed,
      parseFindings: outcome.parsed.findings,
    }).filter((finding) => finding.severity === 'P2' || finding.severity === 'P3');
    const baseline = {
      schemaVersion: 1,
      owner: opts.owner ?? null,
      expires: opts.expires ?? null,
      captured_at: new Date().toISOString(),
      warnings: findings.map((finding) => ({
        fingerprint: fingerprintFinding(finding),
        code: finding.code,
        severity: finding.severity,
        file: finding.file ?? null,
        entity_id: finding.entityId ?? null,
        message: finding.message,
      })),
    };
    const path = warningBaselinePath(cwd, outcome.config);
    if (opts.write) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    }
    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: emitJson(jsonOk({ path, write: opts.write, baseline })),
        stderr: '',
      };
    }
    return {
      exitCode: EXIT_OK,
      stdout: `${opts.write ? 'Wrote' : 'Preview'} warnings baseline (${baseline.warnings.length} warning(s))\n  ${path}\n`,
      stderr: '',
    };
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
}
