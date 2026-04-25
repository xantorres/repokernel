export type RepoKernelErrorKind =
  | 'CONFIG_FILE_NOT_FOUND'
  | 'CONFIG_FILE_UNREADABLE'
  | 'IO_ERROR'
  | 'INTERNAL';

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
