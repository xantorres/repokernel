import { canonicalJson } from '@repokernel/core';

export function emitJson(value: unknown): string {
  return canonicalJson(value);
}
