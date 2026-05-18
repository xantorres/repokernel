import { canonicalJson } from '../output/canonicalJson.js';
import type { Registry } from '../schemas/registry.js';

const VOLATILE_KEYS = new Set(['generatedAt', 'generatedBy']);

export interface DriftReport {
  readonly drift: boolean;
  readonly current: string;
  readonly previous: string;
  readonly reason?: string;
}

export function compareRegistries(current: Registry, previous: Registry): DriftReport {
  const a = canonicalJson(stripVolatile(current));
  const b = canonicalJson(stripVolatile(previous));
  return {
    drift: a !== b,
    current: a,
    previous: b,
    ...(a !== b ? { reason: firstDiff(a, b) } : {}),
  };
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

function firstDiff(currentJson: string, previousJson: string): string {
  let current: unknown;
  let previous: unknown;
  try {
    current = JSON.parse(currentJson);
    previous = JSON.parse(previousJson);
  } catch {
    return 'canonical registry JSON differs';
  }
  return firstDiffValue(current, previous, '$') ?? 'canonical registry JSON differs';
}

function firstDiffValue(current: unknown, previous: unknown, path: string): string | null {
  if (Object.is(current, previous)) return null;

  if (Array.isArray(current) || Array.isArray(previous)) {
    if (!Array.isArray(current) || !Array.isArray(previous)) {
      return `${path}: generated ${describe(current)}, registry ${describe(previous)}`;
    }
    const max = Math.max(current.length, previous.length);
    for (let i = 0; i < max; i += 1) {
      if (i >= current.length) return `${path}[${i}]: missing from generated registry`;
      if (i >= previous.length) return `${path}[${i}]: missing from stored registry`;
      const nested = firstDiffValue(current[i], previous[i], `${path}[${i}]`);
      if (nested) return nested;
    }
    return null;
  }

  if (isRecord(current) || isRecord(previous)) {
    if (!isRecord(current) || !isRecord(previous)) {
      return `${path}: generated ${describe(current)}, registry ${describe(previous)}`;
    }
    const keys = [...new Set([...Object.keys(current), ...Object.keys(previous)])].sort();
    for (const key of keys) {
      if (!Object.hasOwn(current, key)) return `${path}.${key}: missing from generated registry`;
      if (!Object.hasOwn(previous, key)) return `${path}.${key}: missing from stored registry`;
      const nested = firstDiffValue(current[key], previous[key], `${path}.${key}`);
      if (nested) return nested;
    }
    return null;
  }

  return `${path}: generated ${describe(current)}, registry ${describe(previous)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null || typeof value !== 'object') return String(value);
  return Array.isArray(value) ? `[array:${value.length}]` : '{object}';
}
