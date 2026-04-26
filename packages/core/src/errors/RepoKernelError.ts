export function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return String(e);
}

export type RepoKernelErrorKind =
  | 'CONFIG_FILE_NOT_FOUND'
  | 'CONFIG_FILE_UNREADABLE'
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
