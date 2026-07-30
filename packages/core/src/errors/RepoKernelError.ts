export function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return String(e);
}

export type RepoKernelErrorKind =
  | 'CONFIG_FILE_NOT_FOUND'
  | 'CONFIG_FILE_UNREADABLE'
  | 'CONFIG_INVALID'
  | 'INVALID_FRONTMATTER'
  | 'INVALID_SENTINEL_OUTPUT'
  | 'IO_ERROR'
  | 'GATE_KEY_INVALID'
  | 'SECRET_DETECTED'
  | 'SECRET_SCAN_FAILED'
  | 'TRUST_DENIED'
  | 'TRUST_FILE_INVALID'
  | 'TRUST_FILE_UNREADABLE'
  | 'TRUST_FILE_VERSION_UNSUPPORTED'
  | 'INTERNAL'
  | 'WORKTREE_ACQUIRE_DIRTY_TREE';

export class RepoKernelError extends Error {
  readonly kind: RepoKernelErrorKind;
  override readonly cause?: unknown;

  constructor(kind: RepoKernelErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'RepoKernelError';
    this.kind = kind;
    if (cause !== undefined) this.cause = cause;
  }
}

const DOCS_BASE = 'https://github.com/xantorres/repokernel';

const DOCS_PATHS: Readonly<Partial<Record<RepoKernelErrorKind, string>>> = {
  CONFIG_FILE_NOT_FOUND: '#getting-started',
  CONFIG_FILE_UNREADABLE: '#getting-started',
  CONFIG_INVALID: '#getting-started',
  TRUST_DENIED: '/blob/main/docs/trust.md',
  TRUST_FILE_INVALID: '/blob/main/docs/trust.md',
  TRUST_FILE_UNREADABLE: '/blob/main/docs/trust.md',
  TRUST_FILE_VERSION_UNSUPPORTED: '/blob/main/docs/trust.md',
  SECRET_SCAN_FAILED: '/blob/main/docs/trust.md',
  INVALID_SENTINEL_OUTPUT: '/blob/main/docs/trust.md',
  WORKTREE_ACQUIRE_DIRTY_TREE: '#why-worktrees--validation-gates',
};

/**
 * Resolve a documentation URL for a given error kind. Returns a generic README
 * link for unmapped kinds. Used to append recovery hints to error messages.
 */
export function docsUrl(kind: RepoKernelErrorKind): string {
  return `${DOCS_BASE}${DOCS_PATHS[kind] ?? '#readme'}`;
}
