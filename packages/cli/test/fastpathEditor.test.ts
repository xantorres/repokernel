import { describe, expect, it } from 'vitest';
import { parseEditorTemplate, resolveEditorCommand } from '../src/commands/fastpath/editor.js';

describe('parseEditorTemplate', () => {
  it('returns null for an empty body', () => {
    const raw = `# What should the agent do? (required)

# Acceptance criteria (optional, one per line)

# Constraints / forbidden paths (optional, one per line)

# Lines starting with # are ignored.
`;
    expect(parseEditorTemplate(raw, 'editor')).toBeNull();
  });

  it('extracts body, criteria, and constraints separately', () => {
    const raw = `# What should the agent do? (required)
Add a /health endpoint to the API.

# Acceptance criteria (optional, one per line)
- Returns 200 OK
- Includes commit SHA in body

# Constraints / forbidden paths (optional, one per line)
- src/legacy/**
`;
    const result = parseEditorTemplate(raw, 'editor');
    expect(result).not.toBeNull();
    expect(result?.body).toContain('Add a /health endpoint');
    expect(result?.acceptanceCriteria).toEqual(['Returns 200 OK', 'Includes commit SHA in body']);
    expect(result?.constraints).toEqual(['src/legacy/**']);
    expect(result?.source).toBe('editor');
  });

  it('strips bullets and skips empty lines from criteria', () => {
    const raw = `# What should the agent do? (required)
Body text.

# Acceptance criteria
- First
*  Second

   - Third
`;
    const result = parseEditorTemplate(raw, 'editor');
    expect(result?.acceptanceCriteria).toEqual(['First', 'Second', 'Third']);
  });

  it('treats lines starting with `#` as ignored regardless of section', () => {
    const raw = `# What should the agent do? (required)
Real body.
# this is a comment that should not become body content
`;
    const result = parseEditorTemplate(raw, 'editor');
    expect(result?.body).toBe('Real body.');
  });

  it('handles CRLF line endings', () => {
    const raw = `# What should the agent do? (required)\r\nBody.\r\n# Acceptance criteria\r\n- One\r\n`;
    const result = parseEditorTemplate(raw, 'editor');
    expect(result?.body).toBe('Body.');
    expect(result?.acceptanceCriteria).toEqual(['One']);
  });

  it('matches "Constraints" or "forbidden" section headings', () => {
    const a = parseEditorTemplate(`# Body\nbody\n# Constraints\n- A\n`, 'editor');
    const b = parseEditorTemplate(`# Body\nbody\n# forbidden paths\n- B\n`, 'editor');
    expect(a?.constraints).toEqual(['A']);
    expect(b?.constraints).toEqual(['B']);
  });
});

describe('resolveEditorCommand', () => {
  it('prefers RK_EDITOR over VISUAL/EDITOR', () => {
    const argv = resolveEditorCommand({
      RK_EDITOR: 'code --wait',
      VISUAL: 'nano',
      EDITOR: 'vi',
    });
    expect(argv).toEqual(['code', '--wait']);
  });

  it('falls back to VISUAL when RK_EDITOR is empty', () => {
    const argv = resolveEditorCommand({
      RK_EDITOR: '',
      VISUAL: 'nano',
      EDITOR: 'vi',
    });
    expect(argv).toEqual(['nano']);
  });

  it('falls back to EDITOR when RK_EDITOR and VISUAL are unset', () => {
    const argv = resolveEditorCommand({ EDITOR: 'vim' });
    expect(argv).toEqual(['vim']);
  });

  it('falls back to vi on darwin/linux when no env vars are set', () => {
    const original = process.platform;
    if (original !== 'darwin' && original !== 'linux') return;
    const argv = resolveEditorCommand({});
    expect(argv).toEqual(['vi']);
  });

  it('trims whitespace from the env value', () => {
    const argv = resolveEditorCommand({ RK_EDITOR: '   nvim   ' });
    expect(argv).toEqual(['nvim']);
  });
});
