export function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return String(e);
}

export type RepoKernelErrorKind =
  | 'CONFIG_FILE_NOT_FOUND'
  | 'CONFIG_FILE_UNREADABLE'
  | 'INVALID_FRONTMATTER'
  | 'IO_ERROR'
  | 'SECRET_DETECTED'
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
  WORKTREE_ACQUIRE_DIRTY_TREE: '#workflow',
};

/**
 * Resolve a documentation URL for a given error kind. Returns a generic README
 * link for unmapped kinds. Used to append recovery hints to error messages.
 */
export function docsUrl(kind: RepoKernelErrorKind): string {
  return `${DOCS_BASE}${DOCS_PATHS[kind] ?? '#readme'}`;
}
