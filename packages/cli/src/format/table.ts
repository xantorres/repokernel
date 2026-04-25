// biome-ignore lint/complexity/useRegexLiterals: regex literal triggers noControlCharactersInRegex
const ANSI_RE = new RegExp('\\[[0-9;]*m', 'gu');

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export function visualLen(s: string): number {
  return stripAnsi(s).length;
}

export function padEnd(s: string, width: number): string {
  const pad = width - visualLen(s);
  return pad > 0 ? `${s}${' '.repeat(pad)}` : s;
}

export function truncate(s: string, maxLen: number): string {
  if (visualLen(s) <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

export interface ColumnDef {
  readonly key: string;
  readonly header: string;
  readonly width?: number;
  readonly align?: 'left' | 'right';
  readonly render?: (value: string) => string;
}

export function renderTable(
  rows: ReadonlyArray<Record<string, string>>,
  cols: readonly ColumnDef[],
): string {
  const widths = cols.map((col) => {
    if (col.width !== undefined) return col.width;
    const contentMax = rows.reduce((max, row) => {
      const raw = row[col.key] ?? '';
      return Math.max(max, visualLen(raw));
    }, 0);
    return Math.max(col.header.length, contentMax);
  });

  const sep = cols.map((_, i) => '─'.repeat(widths[i]!)).join('  ');
  const header = cols.map((col, i) => padEnd(col.header, widths[i]!)).join('  ');

  const dataRows = rows.map((row) =>
    cols
      .map((col, i) => {
        const raw = row[col.key] ?? '';
        const colored = col.render ? col.render(raw) : raw;
        if (col.align === 'right') {
          const pad = widths[i]! - visualLen(colored);
          return pad > 0 ? `${' '.repeat(pad)}${colored}` : colored;
        }
        return padEnd(colored, widths[i]!);
      })
      .join('  '),
  );

  return [header, sep, ...dataRows].join('\n');
}
