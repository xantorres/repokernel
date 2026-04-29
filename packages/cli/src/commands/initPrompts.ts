import { createInterface, type Interface } from 'node:readline/promises';

export const SUPPORTED_AGENTS = ['manual', 'fake', 'claude', 'codex', 'ollama'] as const;
export type SupportedAgent = (typeof SUPPORTED_AGENTS)[number];

export interface PromptIO {
  question(prompt: string): Promise<string>;
  readonly isTTY: boolean;
}

export interface InitChoices {
  readonly agent: string;
  readonly lane: string;
  readonly checksCmd: string | null;
  readonly example: boolean;
}

export interface InitPromptFlags {
  readonly agent?: string;
  readonly lane?: string;
  readonly checksCmd?: string;
  readonly example?: boolean;
  readonly nonInteractive?: boolean;
}

export function defaultsFor(flags: InitPromptFlags): InitChoices {
  const example = flags.example === true;
  return {
    agent: flags.agent ?? (example ? 'fake' : 'manual'),
    lane: flags.lane ?? 'main',
    checksCmd: flags.checksCmd && flags.checksCmd.length > 0 ? flags.checksCmd : null,
    example,
  };
}

function shouldSkipPrompts(io: PromptIO, flags: InitPromptFlags): boolean {
  if (flags.nonInteractive === true) return true;
  if (!io.isTTY) return true;
  const allFlagsSet =
    flags.agent !== undefined &&
    flags.lane !== undefined &&
    flags.checksCmd !== undefined &&
    flags.example !== undefined;
  return allFlagsSet;
}

function isAgentName(value: string): boolean {
  return /^[a-z][a-z0-9_-]*$/.test(value);
}

function slugifyLane(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');
}

export async function gatherInitChoices(
  io: PromptIO,
  flags: InitPromptFlags,
): Promise<InitChoices> {
  if (shouldSkipPrompts(io, flags)) return defaultsFor(flags);

  // Ask example first so the agent default reflects the choice.
  const example = flags.example ?? (await promptExample(io));
  const agentDefault = example ? 'fake' : 'manual';
  const agent = flags.agent ?? (await promptAgent(io, agentDefault));
  const lane = flags.lane ?? (await promptLane(io, 'main'));
  const checksCmd =
    flags.checksCmd !== undefined
      ? flags.checksCmd.length > 0
        ? flags.checksCmd
        : null
      : await promptChecksCmd(io);

  return { agent, lane, checksCmd, example };
}

async function promptAgent(io: PromptIO, fallback: string): Promise<string> {
  const list = SUPPORTED_AGENTS.join(' / ');
  while (true) {
    const raw = (await io.question(`Agent adapter (${list}) [${fallback}]: `)).trim();
    if (raw.length === 0) return fallback;
    if (isAgentName(raw)) return raw;
  }
}

async function promptLane(io: PromptIO, fallback: string): Promise<string> {
  while (true) {
    const raw = (await io.question(`Default lane name [${fallback}]: `)).trim();
    if (raw.length === 0) return fallback;
    const slug = slugifyLane(raw);
    if (slug.length > 0) return slug;
  }
}

async function promptChecksCmd(io: PromptIO): Promise<string | null> {
  const raw = (await io.question('Checks command (e.g. "pnpm test"; blank to skip): ')).trim();
  return raw.length > 0 ? raw : null;
}

async function promptExample(io: PromptIO): Promise<boolean> {
  const raw = (await io.question('Scaffold example sprints? [Y/n]: ')).trim().toLowerCase();
  if (raw.length === 0) return true;
  return raw === 'y' || raw === 'yes';
}

export interface OwnedPromptIO extends PromptIO {
  close(): void;
}

export function ownedPromptIO(): OwnedPromptIO {
  const rl: Interface = createInterface({ input: process.stdin, output: process.stdout });
  return {
    isTTY: Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY),
    question: (prompt: string) => rl.question(prompt),
    close: () => rl.close(),
  };
}
