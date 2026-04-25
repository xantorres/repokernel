export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
// Expected project/user state error (lane claimed, epic not found, review pending, etc.)
// Distinct from EXIT_RUNTIME so scripts can distinguish "fix your project state" from "tool crash".
export const EXIT_BLOCKED = EXIT_FINDINGS;
export const EXIT_RUNTIME = 2;
