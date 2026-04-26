export function aggregateVerdict(
  results: ReadonlyArray<{ readonly verdict: 'GREEN' | 'YELLOW' | 'RED' }>,
): 'GREEN' | 'YELLOW' | 'RED' {
  if (results.some((r) => r.verdict === 'RED')) return 'RED';
  if (results.some((r) => r.verdict === 'YELLOW')) return 'YELLOW';
  return 'GREEN';
}
