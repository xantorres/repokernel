/**
 * Markdown section + prose helpers shared by the strict planning validator and
 * the always-on placeholder-section rule. Parses `## H2` sections and reduces
 * their content to "substantive" text — visible prose with HTML comments,
 * markdown syntax, list markers, and known placeholder phrases stripped — so
 * callers can tell a real section from a template stub.
 */

export interface Section {
  readonly title: string;
  readonly lines: readonly string[];
}

const PLACEHOLDERS = new Set(['tbd', 'todo', 'tests pass', 'implement the thing', 'make it work']);

export function parseH2Sections(body: string): ReadonlyMap<string, Section> {
  const sections = new Map<string, { title: string; lines: string[] }>();
  let current: { title: string; lines: string[] } | null = null;
  for (const line of body.split(/\r?\n/)) {
    const match = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      const title = cleanHeading(match[1] ?? '');
      const key = normalizeHeading(title);
      current = { title, lines: [] };
      if (!sections.has(key)) sections.set(key, current);
      continue;
    }
    current?.lines.push(line);
  }
  return sections;
}

export function cleanHeading(value: string): string {
  return value.replace(/\s+#+\s*$/, '').trim();
}

export function normalizeHeading(value: string): string {
  return cleanHeading(value).toLowerCase().replace(/\s+/g, ' ');
}

export function substantiveText(value: string): string {
  return visibleLines(value)
    .filter((line) => !isPlaceholder(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function visibleText(value: string): string {
  return visibleLines(value).join(' ').replace(/\s+/g, ' ').trim();
}

export function visibleLines(value: string): readonly string[] {
  return stripHtmlComments(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))
    .map((line) => line.replace(/^\[[ xX]\]\s*/, ''))
    .map((line) => markdownToText(line))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function hasPlaceholderContent(value: string): boolean {
  const lines = visibleLines(value);
  return lines.length > 0 && lines.every((line) => isPlaceholder(line));
}

export function stripHtmlComments(value: string): string {
  return value.replace(/<!--[\s\S]*?-->/g, '');
}

export function markdownToText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_~>#]/g, '')
    .replace(/\s+/g, ' ');
}

export function isPlaceholder(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replace(/[.!?:;,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return PLACEHOLDERS.has(normalized) || /^(?:todo|tbd)(?:\s|:|-|$)/.test(normalized);
}
