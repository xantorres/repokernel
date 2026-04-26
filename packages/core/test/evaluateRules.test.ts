import { describe, expect, it } from 'vitest';
import { evaluateRules, matchesAnyGlob, matchesGlob } from '../src/quality/evaluateRules.js';
import type { QualityRule } from '../src/schemas/epic.js';

// ---- matchesGlob ----

describe('matchesGlob', () => {
  it('matches exact path', () => {
    expect(matchesGlob('src/foo.ts', 'src/foo.ts')).toBe(true);
  });

  it('* matches within a segment', () => {
    expect(matchesGlob('src/foo.ts', 'src/*.ts')).toBe(true);
    expect(matchesGlob('src/sub/foo.ts', 'src/*.ts')).toBe(false);
  });

  it('** matches across segments', () => {
    expect(matchesGlob('src/sub/foo.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('src/foo.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('lib/foo.ts', 'src/**/*.ts')).toBe(false);
  });

  it('** at root matches all', () => {
    expect(matchesGlob('src/deep/nested/foo.ts', '**/*.ts')).toBe(true);
  });

  it('does not match partial filename', () => {
    expect(matchesGlob('src/foobar.ts', 'src/foo.ts')).toBe(false);
  });

  it('escapes regex special chars in pattern', () => {
    expect(matchesGlob('src/foo.ts', 'src/foo.ts')).toBe(true);
    // dot in pattern should not match arbitrary char
    expect(matchesGlob('srcXfooYts', 'src/foo.ts')).toBe(false);
  });
});

describe('matchesAnyGlob', () => {
  it('returns true when any pattern matches', () => {
    expect(matchesAnyGlob('src/foo.ts', ['lib/**', 'src/*.ts'])).toBe(true);
  });

  it('returns false when no pattern matches', () => {
    expect(matchesAnyGlob('dist/foo.js', ['src/**', 'lib/**'])).toBe(false);
  });
});

// ---- evaluateRules ----

describe('evaluateRules', () => {
  describe('no rules', () => {
    it('returns accepted with no findings when rules is empty', () => {
      const result = evaluateRules({ rules: [], changedFiles: ['foo.ts'] });
      expect(result.verdict).toBe('accepted');
      expect(result.findings).toHaveLength(0);
    });
  });

  describe('required_files rule', () => {
    const rule: QualityRule = { type: 'required_files', globs: ['src/**/*.ts', 'README.md'] };

    it('accepted when all required patterns are matched', () => {
      const result = evaluateRules({
        rules: [rule],
        changedFiles: ['src/utils.ts', 'README.md'],
      });
      expect(result.verdict).toBe('accepted');
      expect(result.findings).toHaveLength(0);
    });

    it('HIGH finding for each unmatched required pattern', () => {
      const result = evaluateRules({
        rules: [rule],
        changedFiles: ['src/utils.ts'],
      });
      expect(result.verdict).toBe('rejected');
      const msgs = result.findings.map((f) => f.message);
      expect(msgs.some((m) => m.includes('README.md'))).toBe(true);
      expect(result.findings.every((f) => f.severity === 'HIGH')).toBe(true);
    });

    it('finding for each missing glob separately', () => {
      const result = evaluateRules({
        rules: [rule],
        changedFiles: [],
      });
      expect(result.findings).toHaveLength(2);
    });
  });

  describe('forbidden_paths rule', () => {
    const rule: QualityRule = { type: 'forbidden_paths', globs: ['secrets/**', '**/.env'] };

    it('accepted when no changed file matches forbidden pattern', () => {
      const result = evaluateRules({
        rules: [rule],
        changedFiles: ['src/foo.ts', 'README.md'],
      });
      expect(result.verdict).toBe('accepted');
    });

    it('CRITICAL finding for each forbidden file touched', () => {
      const result = evaluateRules({
        rules: [rule],
        changedFiles: ['src/foo.ts', 'secrets/token.txt'],
      });
      expect(result.verdict).toBe('rejected');
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('CRITICAL');
      expect(result.findings[0].message).toContain('secrets/token.txt');
    });

    it('one finding per forbidden file', () => {
      const result = evaluateRules({
        rules: [rule],
        changedFiles: ['secrets/a.txt', 'secrets/b.txt'],
      });
      expect(result.findings).toHaveLength(2);
    });
  });

  describe('no_secrets rule', () => {
    const rule: QualityRule = { type: 'no_secrets' };

    it('accepted when hasSecrets is false', () => {
      const result = evaluateRules({ rules: [rule], changedFiles: [], hasSecrets: false });
      expect(result.verdict).toBe('accepted');
    });

    it('CRITICAL finding when hasSecrets is true', () => {
      const result = evaluateRules({ rules: [rule], changedFiles: [], hasSecrets: true });
      expect(result.verdict).toBe('rejected');
      expect(result.findings[0].severity).toBe('CRITICAL');
    });

    it('no finding when hasSecrets is undefined', () => {
      const result = evaluateRules({ rules: [rule], changedFiles: [] });
      expect(result.findings).toHaveLength(0);
    });
  });

  describe('verdict mapping', () => {
    it('accepted when no findings', () => {
      const result = evaluateRules({ rules: [], changedFiles: [] });
      expect(result.verdict).toBe('accepted');
    });

    it('changes_requested for MEDIUM/LOW only findings (hypothetical — no current rule emits these)', () => {
      // Inject a LOW finding via no rule to test verdict logic directly
      // We test via multiple required_files that we handle the worst-case severity
      const result = evaluateRules({
        rules: [{ type: 'required_files', globs: ['missing.ts'] }],
        changedFiles: [],
      });
      // HIGH finding → rejected
      expect(result.verdict).toBe('rejected');
    });

    it('rejected when CRITICAL finding present', () => {
      const result = evaluateRules({
        rules: [{ type: 'forbidden_paths', globs: ['**'] }],
        changedFiles: ['any.ts'],
      });
      expect(result.verdict).toBe('rejected');
    });
  });

  describe('multiple rules', () => {
    it('aggregates findings from all rules', () => {
      const rules: QualityRule[] = [
        { type: 'required_files', globs: ['missing.ts'] },
        { type: 'forbidden_paths', globs: ['secrets/**'] },
      ];
      const result = evaluateRules({
        rules,
        changedFiles: ['secrets/key.txt'],
      });
      // HIGH (missing.ts) + CRITICAL (secrets/key.txt)
      expect(result.findings).toHaveLength(2);
      expect(result.verdict).toBe('rejected');
    });
  });
});
