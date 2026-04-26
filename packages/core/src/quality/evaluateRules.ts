import type { QualityRule } from '../schemas/epic.js';
import type { ReviewFinding, ReviewVerdict } from '../schemas/review.js';

export interface EvaluateRulesInput {
  readonly rules: readonly QualityRule[];
  readonly changedFiles: readonly string[];
  readonly hasSecrets?: boolean;
}

export interface EvaluateRulesResult {
  readonly verdict: ReviewVerdict;
  readonly findings: ReviewFinding[];
}

const P_DSTAR_SLASH = '<<DSTARSLASH>>';
const P_SLASH_DSTAR = '<<SLASHDSTAR>>';
const P_DSTAR = '<<DSTAR>>';
const P_STAR = '<<STAR>>';
const P_QMARK = '<<QMARK>>';

function globToRegex(pattern: string): RegExp {
  // Use named placeholders to avoid double-replacing already-inserted regex chars.
  // Order matters: replace longer tokens first.
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars (but not * or ?)
    .replace(/\*\*\//g, P_DSTAR_SLASH) // **/ → zero or more path segments (with trailing /)
    .replace(/\/\*\*/g, P_SLASH_DSTAR) // /** → zero or more path segments (with leading /)
    .replace(/\*\*/g, P_DSTAR) // standalone ** → any characters
    .replace(/\*/g, P_STAR) // * → any chars except /
    .replace(/\?/g, P_QMARK) // ? → any single char except /
    .replaceAll(P_DSTAR_SLASH, '(?:[^/]+/)*')
    .replaceAll(P_SLASH_DSTAR, '(?:/[^/]+)*')
    .replaceAll(P_DSTAR, '.*')
    .replaceAll(P_STAR, '[^/]*')
    .replaceAll(P_QMARK, '[^/]');
  return new RegExp(`^${regex}$`);
}

export function matchesGlob(filePath: string, pattern: string): boolean {
  return globToRegex(pattern).test(filePath);
}

export function matchesAnyGlob(filePath: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesGlob(filePath, p));
}

export function evaluateRules(input: EvaluateRulesInput): EvaluateRulesResult {
  const findings: ReviewFinding[] = [];

  for (const rule of input.rules) {
    switch (rule.type) {
      case 'required_files': {
        const missing = rule.globs.filter(
          (glob) => !input.changedFiles.some((f) => matchesGlob(f, glob)),
        );
        for (const glob of missing) {
          findings.push({
            severity: 'HIGH',
            message: `required file pattern not satisfied: ${glob}`,
          });
        }
        break;
      }

      case 'forbidden_paths': {
        for (const file of input.changedFiles) {
          if (matchesAnyGlob(file, rule.globs)) {
            findings.push({ severity: 'CRITICAL', message: `forbidden path modified: ${file}` });
          }
        }
        break;
      }

      case 'no_secrets': {
        if (input.hasSecrets) {
          findings.push({
            severity: 'CRITICAL',
            message: 'secret pattern detected in changed files',
          });
        }
        break;
      }
    }
  }

  const verdict = verdictFromFindings(findings);
  return { verdict, findings };
}

function verdictFromFindings(findings: ReviewFinding[]): ReviewVerdict {
  if (findings.length === 0) return 'accepted';
  const hasCriticalOrHigh = findings.some(
    (f) => f.severity === 'CRITICAL' || f.severity === 'HIGH',
  );
  return hasCriticalOrHigh ? 'rejected' : 'changes_requested';
}
