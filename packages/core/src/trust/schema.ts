import { z } from 'zod';

const EnvVarNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Z_][A-Z0-9_]*$/, 'env var name must match [A-Z_][A-Z0-9_]*')
  .refine((s) => !s.includes('*'), 'wildcards are not allowed in trust grants');

export const ReviewerGrantSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env_passthrough: z.array(EnvVarNameSchema).default([]),
    timeout_seconds: z.number().int().positive().default(300),
  })
  .strict();
export type ReviewerGrant = z.infer<typeof ReviewerGrantSchema>;

export const RepoTrustGrantSchema = z
  .object({
    checks_cmd: z.boolean().default(false),
    /**
     * sha256 over the checks command(s) the grant was issued against. Pins the
     * consented content so an edit to `automation.checksCmd` (or any phase)
     * forces a re-grant instead of silently inheriting the old blanket trust.
     * Absent on grants written by an older rk → treated as not pinned.
     */
    checks_cmd_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'checks_cmd_sha256 must be a 64-character hex sha256')
      .optional(),
    env_passthrough: z.array(EnvVarNameSchema).default([]),
    agents: z.array(z.string().min(1)).default([]),
    reviewers: z.record(ReviewerGrantSchema).default({}),
  })
  .strict();
export type RepoTrustGrant = z.infer<typeof RepoTrustGrantSchema>;

export const SUPPORTED_TRUST_FILE_VERSIONS = [1] as const;
export type TrustFileVersion = (typeof SUPPORTED_TRUST_FILE_VERSIONS)[number];

export const UserLocalTrustSchema = z
  .object({
    version: z
      .number()
      .int()
      .refine(
        (v): v is TrustFileVersion =>
          (SUPPORTED_TRUST_FILE_VERSIONS as readonly number[]).includes(v),
        {
          message: `unsupported trust file version (supported: ${SUPPORTED_TRUST_FILE_VERSIONS.join(', ')})`,
        },
      )
      .default(1),
    repos: z.record(RepoTrustGrantSchema).default({}),
  })
  .strict();
export type UserLocalTrust = z.infer<typeof UserLocalTrustSchema>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export const EMPTY_REPO_GRANT: RepoTrustGrant = deepFreeze(RepoTrustGrantSchema.parse({}));
export const EMPTY_USER_TRUST: UserLocalTrust = deepFreeze(UserLocalTrustSchema.parse({}));

const SENSITIVE_ENV_PATTERNS: readonly RegExp[] = [
  /_KEY$/,
  /_TOKEN$/,
  /_SECRET$/,
  /_PASSWORD$/,
  /_PASSPHRASE$/,
  /_DSN$/,
  /_WEBHOOK_URL$/,
  /^AWS_/,
  /^GITHUB_/,
  /^GH_/,
  /^GOOGLE_/,
  /^GCP_/,
  /^AZURE_/,
  /^STRIPE_/,
  /^OPENAI_/,
  /^ANTHROPIC_/,
  /^HUGGINGFACE_/,
  /^COHERE_/,
  /^MISTRAL_/,
  /^GROQ_/,
  /^REPLICATE_/,
  /^PERPLEXITY_/,
  /^NPM_/,
  /^PYPI_/,
  /^CARGO_/,
  /^DATABASE_/,
  /^DATABASE_URL$/,
  /^PASSWORD$/,
  /^PASSPHRASE$/,
  /^TOKEN$/,
  /^SECRET$/,
];

export function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_PATTERNS.some((re) => re.test(name));
}

/**
 * Reject keys that could pollute Object.prototype when read back via bracket
 * lookup on a YAML-derived plain object. yaml@2 normally rejects these in
 * strict mode, but we double-check at the schema boundary as defense in depth.
 */
export const RESERVED_REPO_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];
