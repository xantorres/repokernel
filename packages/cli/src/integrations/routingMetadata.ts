import { mutateSprintExtras } from './sprintExtras.js';

/**
 * `extras.routing` is a discrete sub-object owned exclusively by the
 * routing CLI surface (`rk sprint routing set/clear`). The shape is
 * validated upstream against ComplexityHintSchema / TierNameSchema /
 * RoutingFanoutEntrySchema, so this file treats it as opaque
 * `Record<string, unknown>` and only enforces merge / replace / clear
 * semantics.
 *
 * Three callers used to spread `...readRouting(extras), ...routing` at
 * the call site, which meant a contract bug in any of them silently
 * broke invariants. Funnelling all routing mutations through this
 * primitive collapses the merge logic to one location — siblings of
 * `routing` (e.g. tracker fields, task_id, fastpath) are preserved by
 * the underlying `mutateSprintExtras` lock; the routing block itself
 * is replaced/merged/cleared atomically.
 */
export type Routing = Record<string, unknown>;

export type RoutingUpdate = (current: Routing | null) => Routing | null;

export async function mutateSprintRouting(
  file: string,
  opRoot: string,
  update: RoutingUpdate,
): Promise<{ readonly prior: Routing | null; readonly next: Routing | null }> {
  let prior: Routing | null = null;
  let next: Routing | null = null;
  await mutateSprintExtras(file, opRoot, (extras) => {
    prior = readRouting(extras);
    next = update(prior);
    if (next === null) {
      const { routing: _routing, ...rest } = extras;
      return rest;
    }
    return { ...extras, routing: next };
  });
  return { prior, next };
}

export function readRouting(extras: Readonly<Record<string, unknown>>): Routing | null {
  const r = extras.routing;
  return r && typeof r === 'object' && !Array.isArray(r) ? (r as Routing) : null;
}
