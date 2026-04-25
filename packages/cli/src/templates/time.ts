export function isoNow(): string {
  return new Date().toISOString().slice(0, 19) + 'Z';
}
