import { RepoKernelError } from '@repokernel/core';
import type { TrackerRef, TrackerSource } from './types.js';

const SOURCE_RE = /^(jira|linear|gh):(.+)$/;

const VALID_SOURCES: ReadonlySet<TrackerSource> = new Set(['jira', 'linear', 'gh']);

/**
 * Parse a tracker reference of the form `<source>:<ref>`.
 *
 * Accepted forms:
 *   `gh:owner/repo#123`        — GitHub issue
 *   `jira:KEY-NN`              — JIRA issue (e.g. `GDXINSI-2293`)
 *   `linear:ABC-12`            — Linear issue (team prefix + number)
 *
 * Rejected forms throw `RepoKernelError('CONFIG_INVALID', ...)`. The caller
 * should map this to an exit-with-usage-error condition so misuse is
 * caught at the CLI boundary rather than propagated as a network failure
 * later.
 */
export function parseTrackerRef(input: string, flag = '--from-tracker'): TrackerRef {
  const match = SOURCE_RE.exec(input);
  if (match === null) {
    throw new RepoKernelError(
      'CONFIG_INVALID',
      `${flag} value \`${input}\` is malformed — expected \`<source>:<ref>\` where source is one of: jira, linear, gh`,
    );
  }

  const source = match[1] as TrackerSource;
  const ref = match[2] ?? '';

  if (!VALID_SOURCES.has(source)) {
    throw new RepoKernelError(
      'CONFIG_INVALID',
      `${flag} source \`${source}\` is not supported — must be one of: jira, linear, gh`,
    );
  }

  if (ref.length === 0) {
    throw new RepoKernelError(
      'CONFIG_INVALID',
      `${flag} ref is empty — expected \`${source}:<ref>\` with a non-empty ref`,
    );
  }

  if (source === 'gh' && !/^[\w.-]+\/[\w.-]+#\d+$/.test(ref)) {
    throw new RepoKernelError(
      'CONFIG_INVALID',
      `${flag} gh ref \`${ref}\` is malformed — expected \`owner/repo#NNN\``,
    );
  }
  if (source === 'jira' && !/^[A-Z][A-Z0-9_]*-\d+$/.test(ref)) {
    throw new RepoKernelError(
      'CONFIG_INVALID',
      `${flag} jira ref \`${ref}\` is malformed — expected \`KEY-NNN\` (uppercase key, digits)`,
    );
  }
  if (source === 'linear' && !/^[A-Z][A-Z0-9]*-\d+$/.test(ref)) {
    throw new RepoKernelError(
      'CONFIG_INVALID',
      `${flag} linear ref \`${ref}\` is malformed — expected \`ABC-NNN\` (uppercase team prefix, digits)`,
    );
  }

  return { source, ref };
}
