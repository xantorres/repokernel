import { readFile } from 'node:fs/promises';
import {
  canonicalJson,
  checkRegistryIntegrity,
  type MergeRegistryResult,
  mergeRegistries,
  mergeRegistriesThreeWay,
  type Registry,
  type RegistryIntegrityIssue,
  RegistrySchema,
} from '@repokernel/core';
import { atomicWriteText } from '../atomicWrite.js';

/**
 * Outcome of running the registry merge driver.
 *
 * `ok` is `true` only when the JSON parse, schema validation, deterministic
 * merge, and post-merge integrity check all succeed without conflicts. Any
 * conflict (immutable-field divergence, lane double-claim, integrity issue)
 * surfaces here so the caller can choose to abort the merge instead of
 * silently writing a registry that contradicts the entity files.
 */
export interface MergeDriverResult {
  readonly ok: boolean;
  readonly merged?: Registry;
  readonly conflicts: MergeRegistryResult['conflicts'];
  readonly integrityIssues: readonly RegistryIntegrityIssue[];
  readonly errors: readonly string[];
}

/**
 * Run the registry merge driver.
 *
 * Inputs are file paths in git's standard merge-driver convention:
 *   - `currentPath` (`%A`): the version on the branch being merged into.
 *     The driver writes the merged content here on success.
 *   - `otherPath` (`%B`): the incoming version from the branch being merged.
 *   - `basePath` (`%O`): the common ancestor. When present, the driver
 *     performs delete-aware three-way resolution so one branch deleting an
 *     unchanged entity does not resurrect it from the other branch.
 *
 * The driver never throws on parse / schema failure: those bubble through
 * the result object so git records a clean conflict-marker file rather than
 * an opaque process crash.
 */
export async function runRegistryMergeDriver(args: {
  readonly currentPath: string;
  readonly otherPath: string;
  readonly basePath?: string;
}): Promise<MergeDriverResult> {
  const errors: string[] = [];

  const current = await loadRegistry(args.currentPath, errors, 'current');
  const other = await loadRegistry(args.otherPath, errors, 'other');
  const base =
    args.basePath === undefined ? undefined : await loadRegistry(args.basePath, errors, 'base');

  if (current === null || other === null || base === null) {
    return {
      ok: false,
      conflicts: [],
      integrityIssues: [],
      errors,
    };
  }

  const result =
    base === undefined
      ? mergeRegistries(current, other)
      : mergeRegistriesThreeWay(base, current, other);
  const integrityIssues = checkRegistryIntegrity(result.registry);

  if (result.conflicts.length > 0 || integrityIssues.length > 0) {
    return {
      ok: false,
      conflicts: result.conflicts,
      integrityIssues,
      errors,
    };
  }

  await atomicWriteText(args.currentPath, canonicalJson(result.registry));

  return {
    ok: true,
    merged: result.registry,
    conflicts: [],
    integrityIssues: [],
    errors,
  };
}

async function loadRegistry(
  path: string,
  errors: string[],
  side: 'current' | 'other' | 'base',
): Promise<Registry | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    errors.push(`failed to read ${side} registry at ${path}: ${describe(cause)}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    errors.push(`failed to parse ${side} registry as JSON: ${describe(cause)}`);
    return null;
  }
  const validated = RegistrySchema.safeParse(parsed);
  if (!validated.success) {
    errors.push(
      `${side} registry failed schema validation: ${validated.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
    return null;
  }
  return validated.data;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
