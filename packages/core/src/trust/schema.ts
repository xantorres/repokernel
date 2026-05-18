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
    env_passthrough: z.array(EnvVarNameSchema).default([]),
    agents: z.array(z.string().min(1)).default([]),
    reviewers: z.record(ReviewerGrantSchema).default({}),
  })
  .strict();
export type RepoTrustGrant = z.infer<typeof RepoTrustGrantSchema>;

export const UserLocalTrustSchema = z
  .object({
    version: z.literal(1).default(1),
    repos: z.record(RepoTrustGrantSchema).default({}),
  })
  .strict();
export type UserLocalTrust = z.infer<typeof UserLocalTrustSchema>;

export const EMPTY_REPO_GRANT: RepoTrustGrant = RepoTrustGrantSchema.parse({});
export const EMPTY_USER_TRUST: UserLocalTrust = UserLocalTrustSchema.parse({});

const SENSITIVE_ENV_PATTERNS: readonly RegExp[] = [
  /_KEY$/,
  /_TOKEN$/,
  /_SECRET$/,
  /^AWS_/,
  /^GITHUB_/,
  /^GH_/,
  /^GOOGLE_/,
  /^GCP_/,
  /^AZURE_/,
  /^STRIPE_/,
  /^OPENAI_/,
  /^ANTHROPIC_/,
];

export function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_PATTERNS.some((re) => re.test(name));
}
