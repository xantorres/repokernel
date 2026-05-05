/**
 * Shared URL helpers used across integration adapters.
 *
 * The schema layer (`HttpUrlSchema` in core) already rejects non-http(s)
 * URLs at the persistence boundary; these helpers exist for runtime
 * checks on values that haven't gone through Zod (e.g. CLI-supplied
 * arguments).
 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
