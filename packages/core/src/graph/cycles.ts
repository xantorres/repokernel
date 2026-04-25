export interface Cycle {
  readonly nodes: readonly string[];
}

export function findCycles(adj: ReadonlyMap<string, readonly string[]>): Cycle[] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: Cycle[] = [];
  let counter = 0;

  const sortedNodes = [...adj.keys()].sort();

  function strongconnect(v: string): void {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    const neighbors = [...(adj.get(v) ?? [])].sort();
    for (const w of neighbors) {
      if (!index.has(w)) {
        if (!adj.has(w)) continue;
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v) ?? 0, lowlink.get(w) ?? 0));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v) ?? 0, index.get(w) ?? 0));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const component: string[] = [];
      for (;;) {
        const w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      const isCycle = component.length > 1 || (adj.get(v) ?? []).includes(v);
      if (isCycle) {
        cycles.push({ nodes: component.sort() });
      }
    }
  }

  for (const v of sortedNodes) {
    if (!index.has(v)) strongconnect(v);
  }

  return cycles.sort((a, b) => (a.nodes[0] ?? '').localeCompare(b.nodes[0] ?? ''));
}
