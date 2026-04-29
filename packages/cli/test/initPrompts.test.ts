import { describe, expect, it } from 'vitest';
import {
  defaultsFor,
  gatherInitChoices,
  type InitPromptFlags,
  type PromptIO,
} from '../src/commands/initPrompts.js';

interface ScriptedAnswers {
  readonly answers: readonly string[];
}

function fakeIO(isTTY: boolean, scripted: ScriptedAnswers = { answers: [] }): PromptIO {
  let i = 0;
  const captured: string[] = [];
  const io: PromptIO = {
    isTTY,
    async question(prompt: string): Promise<string> {
      captured.push(prompt);
      const answer = scripted.answers[i] ?? '';
      i += 1;
      return answer;
    },
  };
  return io;
}

describe('gatherInitChoices', () => {
  it('returns defaults when stdin is not a TTY', async () => {
    const io = fakeIO(false);
    const choices = await gatherInitChoices(io, {});
    expect(choices).toEqual({
      agent: 'manual',
      lane: 'main',
      checksCmd: null,
      example: false,
    });
  });

  it('returns defaults when --non-interactive is set', async () => {
    const io = fakeIO(true);
    const choices = await gatherInitChoices(io, { nonInteractive: true });
    expect(choices.agent).toBe('manual');
    expect(choices.lane).toBe('main');
    expect(choices.checksCmd).toBeNull();
    expect(choices.example).toBe(false);
  });

  it('flips agent default to "fake" when --example is set', async () => {
    const io = fakeIO(false);
    const choices = await gatherInitChoices(io, { example: true });
    expect(choices.agent).toBe('fake');
    expect(choices.example).toBe(true);
  });

  it('flag --agent overrides the default', async () => {
    const io = fakeIO(false);
    const choices = await gatherInitChoices(io, { agent: 'claude' });
    expect(choices.agent).toBe('claude');
  });

  it('skips prompts when all four flags are supplied', async () => {
    const io = fakeIO(true, { answers: ['SHOULD_NOT_BE_USED'] });
    const flags: InitPromptFlags = {
      agent: 'codex',
      lane: 'release',
      checksCmd: 'pnpm test',
      example: true,
    };
    const choices = await gatherInitChoices(io, flags);
    expect(choices).toEqual({
      agent: 'codex',
      lane: 'release',
      checksCmd: 'pnpm test',
      example: true,
    });
  });

  it('walks all 4 prompts when TTY and no flags', async () => {
    const io = fakeIO(true, {
      answers: ['n', 'claude', 'release', 'pnpm test'],
    });
    const choices = await gatherInitChoices(io, {});
    expect(choices).toEqual({
      agent: 'claude',
      lane: 'release',
      checksCmd: 'pnpm test',
      example: false,
    });
  });

  it('blank checks-cmd answer omits the field', async () => {
    const io = fakeIO(true, {
      answers: ['Y', '', '', ''],
    });
    const choices = await gatherInitChoices(io, {});
    expect(choices.example).toBe(true);
    expect(choices.agent).toBe('fake');
    expect(choices.lane).toBe('main');
    expect(choices.checksCmd).toBeNull();
  });

  it('slugifies lane input', async () => {
    const io = fakeIO(true, {
      answers: ['n', '', 'Release Branch', ''],
    });
    const choices = await gatherInitChoices(io, {});
    expect(choices.lane).toBe('release-branch');
  });
});

describe('defaultsFor', () => {
  it('returns vendor-neutral defaults', () => {
    expect(defaultsFor({})).toEqual({
      agent: 'manual',
      lane: 'main',
      checksCmd: null,
      example: false,
    });
  });

  it('uses fake when example is true', () => {
    expect(defaultsFor({ example: true }).agent).toBe('fake');
  });

  it('does not override an explicit --agent flag', () => {
    expect(defaultsFor({ example: true, agent: 'manual' }).agent).toBe('manual');
  });
});
