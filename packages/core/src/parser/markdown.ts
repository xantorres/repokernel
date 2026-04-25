import matter from 'gray-matter';
import { parse as parseYaml } from 'yaml';

export interface ParsedMarkdown {
  readonly data: Record<string, unknown>;
  readonly body: string;
}

export type ReadMarkdownResult =
  | { ok: true; parsed: ParsedMarkdown }
  | { ok: false; error: string };

const YAML_ENGINE = {
  parse: (str: string): object => {
    const out = parseYaml(str, { strict: true }) as unknown;
    if (out === null || out === undefined) return {};
    if (typeof out !== 'object') return { __scalar: out } as object;
    return out as object;
  },
  stringify: (): string => {
    throw new Error('stringify not supported');
  },
};

export function parseMarkdown(text: string): ReadMarkdownResult {
  try {
    const result = matter(text, {
      engines: { yaml: YAML_ENGINE },
      language: 'yaml',
    });
    const data = (result.data ?? {}) as Record<string, unknown>;
    return { ok: true, parsed: { data, body: result.content ?? '' } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
