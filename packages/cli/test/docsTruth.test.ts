import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
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

async function listPluginSlashCommands(): Promise<string[]> {
  const commandDir = join(REPO_ROOT, 'packages', 'cli', 'plugin', 'commands');
  const files = await readdir(commandDir);
  return files
    .filter((file) => /^rk-[a-z0-9-]+\.md$/.test(file))
    .map((file) => `/${file.replace(/\.md$/, '')}`)
    .sort();
}

function countWord(count: number): string {
  const words = new Map<number, string>([
    [1, 'One'],
    [2, 'Two'],
    [3, 'Three'],
    [4, 'Four'],
    [5, 'Five'],
    [6, 'Six'],
    [7, 'Seven'],
    [8, 'Eight'],
    [9, 'Nine'],
    [10, 'Ten'],
    [11, 'Eleven'],
    [12, 'Twelve'],
  ]);
  return words.get(count) ?? String(count);
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

// Bumped from 15s — atomic writes (PR3) push the parallel-vitest worker
// disk into contention on macOS APFS, and the introspection step shells
// out to many `rk help` invocations.
const HELP_INTROSPECTION_TIMEOUT_MS = 30_000;

describe('docs truth — every `rk <verb>` mentioned in the docs maps to a real command', () => {
  const commandsPromise = listRkCommands();

  it(
    'CLI surface introspection works',
    async () => {
      const cmds = await commandsPromise;
      expect(cmds.find((c) => c.path === 'validate')).toBeDefined();
      expect(cmds.find((c) => c.path === 'task.list')).toBeDefined();
      expect(cmds.find((c) => c.path === 'task.status')).toBeDefined();
      expect(cmds.find((c) => c.path === 'task.inspect')).toBeDefined();
      for (const path of ['ship', 'gates', 'plan', 'wave', 'review-evidence', 'epic.ship']) {
        expect(
          cmds.find((c) => c.path === path),
          `${path} command is discoverable`,
        ).toBeDefined();
      }
    },
    HELP_INTROSPECTION_TIMEOUT_MS,
  );

  for (const file of [
    'README.md',
    'docs/fastpath.md',
    'docs/usage/ci.md',
    'docs/recipes/tracker-driven-flow.md',
    'docs/internals/cli-reference.md',
    'docs/internals/README-detailed.md',
    'packages/cli/plugin/README.md',
    'packages/cli/plugin/skills/repokernel/SKILL.md',
    'packages/cli/plugin/skills/repokernel/reference/cheatsheet.md',
    'packages/cli/plugin/commands/rk-doctor.md',
    'packages/cli/plugin/commands/rk-next.md',
    'packages/cli/plugin/commands/rk-plan.md',
    'packages/cli/plugin/commands/rk-reject.md',
    'packages/cli/plugin/commands/rk-review.md',
    'packages/cli/plugin/commands/rk-run.md',
    'packages/cli/plugin/commands/rk-status.md',
    'examples/skills/repokernel-operator/SKILL.md',
  ]) {
    it(
      `every backticked \`rk <verb>\` in ${file} resolves to a real command`,
      async () => {
        const cmds = await commandsPromise;
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
      },
      HELP_INTROSPECTION_TIMEOUT_MS,
    );
  }

  it('public docs do not pin stale rk-validate action versions', async () => {
    const checked = [
      'README.md',
      'docs/usage/ci.md',
      'docs/recipes/tracker-driven-flow.md',
      '.github/actions/rk-validate/README.md',
      'packages/cli/plugin/skills/repokernel/reference/cheatsheet.md',
    ];
    // Drift catch: the previous release's pin should not appear in
    // user-facing examples after the current release ships. Update this
    // list every release; the docs-bump commit is the natural place.
    const STALE_PINS = [
      'rk-validate@v1.13.0',
      'version: 1.13.0',
      'rk-validate@v1.14.1',
      'version: 1.14.1',
    ];
    const stale: string[] = [];
    for (const file of checked) {
      const doc = await readDoc(file);
      if (STALE_PINS.some((pin) => doc.includes(pin))) stale.push(file);
    }
    expect(stale).toEqual([]);
  });

  it('plugin metadata and README advertise the installed slash command set', async () => {
    const readme = await readDoc('packages/cli/plugin/README.md');
    const manifest = JSON.parse(
      await readDoc('packages/cli/plugin/.claude-plugin/plugin.json'),
    ) as { description?: string };
    const slashCommands = await listPluginSlashCommands();

    for (const command of slashCommands) {
      expect(readme).toContain(command);
    }
    const verbPhrase = `${countWord(slashCommands.length)} verbs`;
    expect(readme).toContain(verbPhrase);
    expect(manifest.description).toContain(verbPhrase);
  });

  // CHANGELOG-tag parity is enforced in scripts/release.sh preflight, NOT
  // in the test suite. Reading `git tag --list` from a shallow CI clone
  // (fetch-depth: 1) would pass the parity check vacuously and lull
  // developers into a false sense of completeness. The release-time check
  // catches drift the moment it would matter.
  it('CHANGELOG has well-formed version headings', async () => {
    const changelog = await readDoc('CHANGELOG.md');
    const headings = [...changelog.matchAll(/^## \[([^\]]+)\] [-—] /gm)].map(
      (match) => match[1] ?? '',
    );
    expect(headings.length).toBeGreaterThan(0);
    for (const heading of headings) {
      // Accept release versions (1.2.3, 1.2.3-rc.1, 1.2.3-beta.2, etc.)
      // and the [Unreleased] convention.
      expect(heading).toMatch(/^(Unreleased|\d+\.\d+\.\d+(-[\w.]+)?)$/);
    }
  });
});
