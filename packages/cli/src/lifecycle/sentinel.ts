import { RepoKernelError } from '@repokernel/core';

export const SENTINEL_START = 'REPOKERNEL_RESULT_START';
export const SENTINEL_END = 'REPOKERNEL_RESULT_END';
export const MAX_SENTINEL_BYTES = 1_048_576; // 1 MB
export const MAX_PROCESS_OUTPUT_BYTES = 10 * 1_048_576; // 10 MB

/**
 * Extract and JSON-parse the sentinel payload between
 * `REPOKERNEL_RESULT_START` and `REPOKERNEL_RESULT_END`. Throws an
 * INVALID_SENTINEL_OUTPUT RepoKernelError on missing markers, oversize
 * payload, or unparseable JSON. Caller passes the result to its specific
 * Zod schema for further validation.
 */
export function extractSentinelPayload(stdout: string): unknown {
  const start = stdout.indexOf(SENTINEL_START);
  const end = stdout.indexOf(SENTINEL_END, start);
  if (start === -1 || end === -1) {
    throw new RepoKernelError(
      'INVALID_SENTINEL_OUTPUT',
      `missing sentinel markers (${SENTINEL_START} / ${SENTINEL_END}) in stdout`,
    );
  }
  const raw = stdout.slice(start + SENTINEL_START.length, end).trim();
  if (raw.length > MAX_SENTINEL_BYTES) {
    throw new RepoKernelError(
      'INVALID_SENTINEL_OUTPUT',
      `sentinel payload exceeds ${MAX_SENTINEL_BYTES} byte limit`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new RepoKernelError(
      'INVALID_SENTINEL_OUTPUT',
      `sentinel payload is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}
