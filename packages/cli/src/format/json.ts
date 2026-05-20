import { canonicalJson } from '@repokernel/core';

export function emitJson(value: unknown): string {
  return canonicalJson(value);
}

export interface JsonErrorEnvelope {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
  readonly warnings: readonly unknown[];
  readonly next_actions: readonly string[];
}

export interface JsonOkEnvelope<T> {
  readonly ok: true;
  readonly data: T;
  readonly warnings: readonly unknown[];
  readonly next_actions: readonly string[];
}

export function jsonOk<T>(
  data: T,
  opts: {
    readonly warnings?: readonly unknown[];
    readonly nextActions?: readonly string[];
  } = {},
): JsonOkEnvelope<T> {
  return {
    ok: true,
    data,
    warnings: opts.warnings ?? [],
    next_actions: opts.nextActions ?? [],
  };
}

export function jsonError(
  code: string,
  message: string,
  opts: {
    readonly details?: unknown;
    readonly warnings?: readonly unknown[];
    readonly nextActions?: readonly string[];
  } = {},
): JsonErrorEnvelope {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(opts.details !== undefined ? { details: opts.details } : {}),
    },
    warnings: opts.warnings ?? [],
    next_actions: opts.nextActions ?? [],
  };
}
