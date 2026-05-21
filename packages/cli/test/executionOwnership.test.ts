import { describe, expect, it } from 'vitest';
import { isExternalAgentEnvironment } from '../src/lifecycle/executionOwnership.js';

describe('isExternalAgentEnvironment', () => {
  it('returns false for a bare environment', () => {
    expect(isExternalAgentEnvironment({ PATH: '/usr/bin', HOME: '/home/u' })).toBe(false);
  });

  it('detects exact agent markers', () => {
    expect(isExternalAgentEnvironment({ CLAUDECODE: '1' })).toBe(true);
    expect(isExternalAgentEnvironment({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe(true);
  });

  it('detects prefix marker families', () => {
    expect(isExternalAgentEnvironment({ CURSOR_TRACE_ID: 'abc' })).toBe(true);
    expect(isExternalAgentEnvironment({ CODEX_SANDBOX: 'seatbelt' })).toBe(true);
  });

  it('detects the vscode integrated terminal', () => {
    expect(isExternalAgentEnvironment({ TERM_PROGRAM: 'vscode' })).toBe(true);
  });

  it('ignores empty marker values', () => {
    expect(isExternalAgentEnvironment({ CLAUDECODE: '' })).toBe(false);
    expect(isExternalAgentEnvironment({ CURSOR_TRACE_ID: '' })).toBe(false);
  });

  it('ignores non-vscode terminals', () => {
    expect(isExternalAgentEnvironment({ TERM_PROGRAM: 'iTerm.app' })).toBe(false);
  });
});
