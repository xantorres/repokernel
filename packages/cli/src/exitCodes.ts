export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
// Expected project/user state error (lane claimed, epic not found, review pending, etc.)
// Distinct from EXIT_RUNTIME so scripts can distinguish "fix your project state" from "tool crash".
export const EXIT_BLOCKED = EXIT_FINDINGS;
export const EXIT_RUNTIME = 2;
// rk context budget gates. Distinct codes so CI can disambiguate "make budget bigger"
// (EXIT_BUDGET_EXCEEDED) from "essential capsule won't fit" (EXIT_BUDGET_TOO_SMALL).
export const EXIT_BUDGET_EXCEEDED = 3;
export const EXIT_BUDGET_TOO_SMALL = 4;
// Bad command-line invocation (mutually-exclusive flags, malformed enum value, etc.).
// Follows sysexits.h convention so agent shells can distinguish "fix your CLI args" from
// EXIT_RUNTIME (tool crash) and EXIT_FINDINGS (project state needs work).
export const EXIT_USAGE = 64;
