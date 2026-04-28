import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

// — helpers —

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DIST = join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');

interface CommandSpec {
  readonly path: string; // dotted path: "task.list", "epic.close", "validate"
  readonly raw: string;
}

async function listRkCommands(): Promise<readonly CommandSpec[]> {
  const top = await runHelp();
  const verbs = parseTopLevelVerbs(top);
  const commands: CommandSpec[] = [];
  for (const verb of verbs) {
    commands.push({ path: verb, raw: verb });
    const sub = await runHelp(verb);
    for (const sub2 of parseSubcommandVerbs(sub)) {
      commands.push({ path: `${verb}.${sub2}`, raw: `${verb} ${sub2}` });
    }
  }
  return commands;
}

async function runHelp(...args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('node', [DIST, ...args, '--help']);
  return stdout;
}

const COMMAND_LINE_RE = /^\s{2}([a-z][a-z0-9-]*)/;

function parseTopLevelVerbs(help: string): string[] {
  // The "Commands:" section lists each verb on its own line, two-space
  // indented. Stop at the first blank line *after* we've seen at least one.
  const verbs: string[] = [];
  let inCommands = false;
  for (const line of help.split('\n')) {
    if (/^Commands:/.test(line)) {
      inCommands = true;
      continue;
    }
    if (!inCommands) continue;
    if (line.trim() === '') {
      if (verbs.length > 0) break;
      continue;
    }
    const match = COMMAND_LINE_RE.exec(line);
    if (match?.[1] && !verbs.includes(match[1]) && match[1] !== 'help') {
      verbs.push(match[1]);
    }
  }
  return verbs;
}

function parseSubcommandVerbs(help: string): string[] {
  // Commander's group-help nests sub-verbs under the same "Commands:" header.
  return parseTopLevelVerbs(help);
}

// Matches the body verbs we care about: backtick + `rk` + verb (+ optional
// sub-verb), capturing both forms `rk task` and `rk task list`.
const RK_VERB_RE = /`rk\s+([a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)?)/g;

async function readDoc(rel: string): Promise<string> {
  return readFile(join(REPO_ROOT, rel), 'utf8');
}

function extractDocumentedCommands(doc: string): string[] {
  const out = new Set<string>();
  RK_VERB_RE.lastIndex = 0;
  for (;;) {
    const match = RK_VERB_RE.exec(doc);
    if (!match) break;
    if (match[1]) out.add(match[1].replace(/\s+/g, ' '));
  }
  return [...out];
}

// — known-OK exceptions: tokens after `rk` that are not commands (entity ids,
// flag-like fragments, prose continuations). The truth-test ignores these. —
const NON_COMMAND_TOKENS: ReadonlySet<string> = new Set([
  'task', // legitimate when followed by a sub-verb; alone is the group name itself, OK
  'next', // `rk next` IS a real command but we still allow the prose form
  'create', // group name
  'queue', // group name
  'epic', // group name
  'sprint', // group name
  'chain', // group name
  'lane', // group name
  'gate', // group name
  'ls', // group name
  'task-list', // legacy hyphenation, never matches anything real but isn't surfaced now
]);

// — tests —

describe('docs truth — every `rk <verb>` mentioned in the docs maps to a real command', () => {
  it('CLI surface introspection works', async () => {
    const cmds = await listRkCommands();
    expect(cmds.find((c) => c.path === 'validate')).toBeDefined();
    expect(cmds.find((c) => c.path === 'task.list')).toBeDefined();
    expect(cmds.find((c) => c.path === 'task.status')).toBeDefined();
    expect(cmds.find((c) => c.path === 'task.inspect')).toBeDefined();
  });

  for (const file of [
    'README.md',
    'docs/fastpath.md',
    'docs/internals/cli-reference.md',
    'docs/internals/README-detailed.md',
  ]) {
    it(`every backticked \`rk <verb>\` in ${file} resolves to a real command`, async () => {
      const cmds = await listRkCommands();
      const flat = new Set<string>();
      for (const c of cmds) {
        flat.add(c.raw); // single-token + multi-token forms
        if (c.raw.includes(' ')) {
          flat.add(c.raw.split(' ')[0] ?? '');
        }
      }
      const doc = await readDoc(file);
      const documented = extractDocumentedCommands(doc);

      const missing: string[] = [];
      for (const verb of documented) {
        const single = verb.split(' ')[0] ?? '';
        if (NON_COMMAND_TOKENS.has(verb) || NON_COMMAND_TOKENS.has(single)) continue;
        if (flat.has(verb) || flat.has(single)) continue;
        missing.push(verb);
      }

      expect(
        missing,
        `docs reference command(s) that no longer exist in rk: ${missing.join(', ')}`,
      ).toEqual([]);
    });
  }
});
