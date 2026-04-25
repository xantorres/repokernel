import { canonicalJson } from '../output/canonicalJson.js';
import type { Registry } from '../schemas/registry.js';

const VOLATILE_KEYS = new Set(['generatedAt', 'generatedBy']);

export interface DriftReport {
  readonly drift: boolean;
  readonly current: string;
  readonly previous: string;
}

export function compareRegistries(current: Registry, previous: Registry): DriftReport {
  const a = canonicalJson(stripVolatile(current));
  const b = canonicalJson(stripVolatile(previous));
  return { drift: a !== b, current: a, previous: b };
}

export function stripVolatile<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripVolatile(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_KEYS.has(k)) continue;
      out[k] = stripVolatile(v);
    }
    return out as T;
  }
  return value;
}
