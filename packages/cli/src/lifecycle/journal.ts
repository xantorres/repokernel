import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isSupportedJournalSchemaVersion,
  type JournalClassification,
  type JournalEnvelope,
  JournalEnvelopeSchema,
  type JournalStep,
  type JournalStepOp,
} from '@repokernel/core';
import { invalidatePreflightCache } from '../commands/preflight.js';
import { atomicCreateText, atomicWriteText } from './atomicWrite.js';
import { journalRoot } from './controlPaths.js';
import { withLockRetrying } from './locks.js';

/**
 * Multi-file mutation journal — write-ahead log for RepoKernel state changes.
 *
 * Scope: strictly local-clone. Lives at `<git-common-dir>/repokernel/journal/`,
 * shared across worktrees of the same clone, never travels through git.
 *
 * Crash recovery: `rk recover --apply` scans for `.pending.json` files and
 * classifies each as safe_replay / already_applied / diverged / unknown_schema
 * / corrupt. See `classifyJournal` for the full decision matrix.
 *
 * Cooperative nesting: a single AsyncLocalStorage<JournalContext> ensures that
 * primitives wrapped in `withJournal` piggy-back on an outer command's journal
 * when one is active, instead of opening their own. One journal file per
 * user-facing command, regardless of how deeply primitives nest.
 *
 * Locking: every outermost `withJournal` acquires the global `journal-write`
 * lock. Existing fine-grained locks (lane, sprint, queue, etc.) remain in
 * their primitive call sites and are acquired INSIDE `journal-write` so two
 * journals can never interleave file mutations.
 */

const JOURNAL_LOCK = 'journal-write';
const JOURNAL_LOCK_DEADLINE_MS = 30_000;
const RETENTION_LIMIT = 50;
const CURRENT_SCHEMA_VERSION = 1;

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeUlidTime(ms: number): string {
  let s = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    s = ULID_ALPHABET[t % 32] + s;
    t = Math.floor(t / 32);
  }
  return s;
}

function encodeUlidRandom(bytes: Buffer): string {
  // 10 bytes = 80 bits = 16 base32 chars (5 bits each).
  const bits: number[] = [];
  for (const b of bytes) {
    for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  }
  let s = '';
  for (let i = 0; i < 16; i++) {
    let v = 0;
    for (let j = 0; j < 5; j++) v = (v << 1) | bits[i * 5 + j];
    s += ULID_ALPHABET[v];
  }
  return s;
}

type UlidGen = () => string;

function defaultUlidGen(): UlidGen {
  let lastMs = -1;
  let lastBytes: Buffer | null = null;
  return () => {
    const now = Date.now();
    if (now === lastMs && lastBytes) {
      // Increment last byte to keep monotonic order within the same ms.
      const bytes = Buffer.from(lastBytes);
      for (let i = bytes.length - 1; i >= 0; i--) {
        if (bytes[i] < 0xff) {
          bytes[i] += 1;
          for (let j = i + 1; j < bytes.length; j++) bytes[j] = 0;
          lastBytes = bytes;
          return `${encodeUlidTime(now)}${encodeUlidRandom(bytes)}`;
        }
      }
      // Overflow — fall through to fresh randomness.
    }
    lastMs = now;
    lastBytes = randomBytes(10);
    return `${encodeUlidTime(now)}${encodeUlidRandom(lastBytes)}`;
  };
}

let _ulid: UlidGen = defaultUlidGen();

/**
 * Override the ULID generator for tests. Pass `null` to restore the default.
 */
export function setUlidGenForTests(gen: UlidGen | null): void {
  _ulid = gen ?? defaultUlidGen();
}

export function nextOpId(): string {
  return `OP-${_ulid()}`;
}

const HEX_HASH_LEN = 64;

export function sha256Buffer(buf: Buffer | string): string {
  const h = createHash('sha256');
  h.update(typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf);
  return h.digest('hex');
}

export async function sha256File(path: string): Promise<string | null> {
  try {
    const buf = await readFile(path);
    return sha256Buffer(buf);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return null;
    throw cause;
  }
}

function decodeContent(content: string, encoding: 'utf8' | 'base64'): Buffer {
  return encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
}

export interface RecordStepInput {
  readonly op: JournalStepOp;
  readonly path: string;
  readonly prevHash: string | null;
  readonly nextHash: string | null;
  readonly content: string | null;
  readonly encoding?: 'utf8' | 'base64';
}

export interface JournalContext {
  readonly opRoot: string;
  readonly opId: string;
  readonly command: string;
  readonly subCommand: string | null;
  readonly pendingPath: string;
  recordStep(input: RecordStepInput): Promise<number>;
  completeStep(stepIndex: number): Promise<void>;
  scoped(subCommand: string): JournalContext;
}

interface JournalContextInternal extends JournalContext {
  readonly envelope: JournalEnvelope;
  closed: boolean;
}

const journalContextStore = new AsyncLocalStorage<JournalContextInternal>();

/**
 * Returns the current journal context if one is active in the calling async
 * scope, else `null`. Exposed for tests + bespoke primitives that want to
 * branch on whether they are running inside an outer command's journal.
 */
export function currentJournalContext(): JournalContext | null {
  return journalContextStore.getStore() ?? null;
}

function makeContext(input: {
  opRoot: string;
  command: string;
  args: Record<string, unknown>;
  subCommand: string | null;
  parent: JournalContextInternal | null;
}): JournalContextInternal {
  const opId = input.parent?.opId ?? nextOpId();
  const pendingPath =
    input.parent?.pendingPath ?? join(journalRoot(input.opRoot), `${opId}.pending.json`);
  const envelope: JournalEnvelope = input.parent
    ? input.parent.envelope
    : {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        opId,
        command: input.command,
        args: input.args,
        startedAt: new Date().toISOString(),
        completedAt: null,
        steps: [],
      };

  const ctx: JournalContextInternal = {
    opRoot: input.opRoot,
    opId,
    command: envelope.command,
    subCommand: input.subCommand,
    pendingPath,
    envelope,
    closed: false,
    async recordStep(step: RecordStepInput): Promise<number> {
      if (ctx.closed) {
        throw new Error('cannot recordStep on a closed journal');
      }
      const stepIndex = envelope.steps.length;
      const journalStep: JournalStep = {
        stepIndex,
        op: step.op,
        path: step.path,
        prevHash: step.prevHash,
        nextHash: step.nextHash,
        content: step.content,
        encoding: step.encoding ?? 'utf8',
        startedAt: new Date().toISOString(),
        completedAt: null,
        ...(ctx.subCommand ? { subCommand: ctx.subCommand } : {}),
      };
      envelope.steps.push(journalStep);
      await persist(envelope, pendingPath);
      return stepIndex;
    },
    async completeStep(stepIndex: number): Promise<void> {
      if (ctx.closed) {
        throw new Error('cannot completeStep on a closed journal');
      }
      const step = envelope.steps[stepIndex];
      if (!step) {
        throw new Error(`unknown stepIndex ${stepIndex}`);
      }
      envelope.steps[stepIndex] = { ...step, completedAt: new Date().toISOString() };
      await persist(envelope, pendingPath);
    },
    scoped(subCommand: string): JournalContext {
      return {
        ...ctx,
        subCommand,
      };
    },
  };
  return ctx;
}

async function persist(envelope: JournalEnvelope, pendingPath: string): Promise<void> {
  await atomicWriteText(pendingPath, `${JSON.stringify(envelope, null, 2)}\n`);
}

async function ensureJournalRoot(opRoot: string): Promise<string> {
  const dir = journalRoot(opRoot);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Bracket a multi-file mutation in a write-ahead journal.
 *
 * Cooperative nesting: if `withJournal` is already active in the caller's
 * async scope and the same `opRoot`, we piggy-back on the outer journal —
 * `command` becomes a `subCommand` tag on the steps `fn` records. No new
 * lock, no new file. The outermost call owns the lifecycle.
 *
 * Outermost calls acquire the global `journal-write` lock for the duration
 * of `fn`, write `OP-<ulid>.pending.json` before any mutation, and rename
 * to `OP-<ulid>.done.json` on success. On thrown errors the pending file is
 * left in place for `rk recover --apply` to inspect.
 */
export async function withJournal<T>(
  opRoot: string,
  command: string,
  args: Record<string, unknown>,
  fn: (ctx: JournalContext) => Promise<T>,
): Promise<T> {
  const existing = journalContextStore.getStore();
  if (existing && existing.opRoot === opRoot) {
    const scoped = makeContext({
      opRoot,
      command: existing.command,
      args: existing.envelope.args,
      subCommand: command,
      parent: existing,
    });
    return journalContextStore.run(scoped, () => fn(scoped));
  }

  return withLockRetrying(
    JOURNAL_LOCK,
    opRoot,
    async () => {
      const dir = await ensureJournalRoot(opRoot);
      const ctx = makeContext({
        opRoot,
        command,
        args,
        subCommand: null,
        parent: null,
      });
      // Write pending.json BEFORE the first mutation. atomicCreateText so a
      // colliding opId surfaces immediately rather than silently merging.
      await atomicCreateText(ctx.pendingPath, `${JSON.stringify(ctx.envelope, null, 2)}\n`);
      let result: T;
      try {
        result = await journalContextStore.run(ctx, () => fn(ctx));
      } catch (err) {
        // Leave .pending.json on disk for recover. Do NOT rename — the
        // operation did not commit.
        ctx.closed = true;
        throw err;
      }
      ctx.envelope.completedAt = new Date().toISOString();
      await persist(ctx.envelope, ctx.pendingPath);
      const donePath = join(dir, `${ctx.opId}.done.json`);
      await rename(ctx.pendingPath, donePath);
      ctx.closed = true;
      await gcJournals(opRoot, RETENTION_LIMIT);
      return result;
    },
    { deadlineMs: JOURNAL_LOCK_DEADLINE_MS },
  );
}

/**
 * Mutate `path` to `content` under the active journal. Captures prev/next
 * SHA-256 and the exact bytes to write so `rk recover` can replay safely.
 *
 * MUST be called from inside `withJournal` — there is no implicit fallback
 * to a fresh journal here, because helpers are already journal-aware via
 * the outer `withJournal` they nest under. Callers that need an outer
 * journal of their own should wrap themselves in `withJournal`.
 */
export async function journalWrite(
  ctx: JournalContext,
  path: string,
  content: string,
): Promise<void> {
  const prevHash = await sha256File(path);
  const nextHash = sha256Buffer(content);
  const stepIndex = await ctx.recordStep({
    op: 'write',
    path,
    prevHash,
    nextHash,
    content,
  });
  await atomicWriteText(path, content);
  await ctx.completeStep(stepIndex);
}

/**
 * Ambient write helper for primitives that do not own their own
 * `withJournal` boundary. If a journal is active in the calling async
 * scope, the write is journaled; otherwise it falls back to plain
 * `atomicWriteText`. This is the migration path for existing primitives
 * (mutate.ts, registry.ts, sprintExtras.ts, etc.) — they switch to
 * `ambientJournalWrite` and gain crash-safety automatically when called
 * from inside a `withJournal` command without breaking standalone callers.
 */
export async function ambientJournalWrite(path: string, content: string): Promise<void> {
  const ctx = journalContextStore.getStore();
  if (ctx) {
    await journalWrite(ctx, path, content);
    return;
  }
  await atomicWriteText(path, content);
}

/**
 * Ambient delete helper, sibling to `ambientJournalWrite`. ENOENT-safe.
 */
export async function ambientJournalDelete(path: string): Promise<void> {
  const ctx = journalContextStore.getStore();
  if (ctx) {
    await journalDelete(ctx, path);
    return;
  }
  try {
    await unlink(path);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') throw cause;
  }
}

/**
 * Ambient atomic-create helper. EEXIST surfaces to caller verbatim.
 */
export async function ambientJournalAtomicCreate(path: string, content: string): Promise<void> {
  const ctx = journalContextStore.getStore();
  if (ctx) {
    await journalAtomicCreate(ctx, path, content);
    return;
  }
  await atomicCreateText(path, content);
}

/**
 * Ambient cache-invalidation helper.
 */
export async function ambientJournalInvalidate(opRoot: string): Promise<void> {
  const ctx = journalContextStore.getStore();
  if (ctx && ctx.opRoot === opRoot) {
    await journalInvalidate(ctx, opRoot);
    return;
  }
  await invalidatePreflightCache(opRoot);
}

/**
 * Atomically create `path` with `content` under the active journal. Throws
 * `EEXIST` if the file already exists, mirroring `atomicCreateText`.
 */
export async function journalAtomicCreate(
  ctx: JournalContext,
  path: string,
  content: string,
): Promise<void> {
  const nextHash = sha256Buffer(content);
  const stepIndex = await ctx.recordStep({
    op: 'atomic-create',
    path,
    prevHash: null,
    nextHash,
    content,
  });
  await atomicCreateText(path, content);
  await ctx.completeStep(stepIndex);
}

/**
 * Delete `path` under the active journal. Records the prev SHA-256 so
 * recovery can detect divergence (e.g. someone re-created the file). Treats
 * ENOENT as a no-op.
 */
export async function journalDelete(ctx: JournalContext, path: string): Promise<void> {
  const prevHash = await sha256File(path);
  const stepIndex = await ctx.recordStep({
    op: 'delete',
    path,
    prevHash,
    nextHash: null,
    content: null,
  });
  try {
    await unlink(path);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') throw cause;
  }
  await ctx.completeStep(stepIndex);
}

/**
 * Invalidate the preflight cache under the active journal. Records the
 * cache file path for forensic clarity but does not store content (the
 * cache is regenerated on next read).
 */
export async function journalInvalidate(ctx: JournalContext, opRoot: string): Promise<void> {
  const cachePath = join(opRoot, 'preflight.json');
  const stepIndex = await ctx.recordStep({
    op: 'invalidate-cache',
    path: cachePath,
    prevHash: null,
    nextHash: null,
    content: null,
  });
  await invalidatePreflightCache(opRoot);
  await ctx.completeStep(stepIndex);
}

// ---------------------------------------------------------------------------
// Recovery — classification + replay
// ---------------------------------------------------------------------------

export interface JournalScanResult {
  readonly opId: string;
  readonly path: string;
  readonly classification: JournalClassification;
  readonly detail: string;
  readonly stepsApplied: number;
  readonly stepsAlreadyApplied: number;
  readonly quarantinedPath?: string;
}

export interface ScanAndHealOptions {
  readonly opRoot: string;
  readonly apply: boolean;
}

export async function listPendingJournals(opRoot: string): Promise<string[]> {
  const dir = journalRoot(opRoot);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return [];
    throw cause;
  }
  return entries
    .filter((f) => f.endsWith('.pending.json'))
    .sort()
    .map((f) => join(dir, f));
}

interface ClassifyOk {
  readonly kind: 'ok';
  readonly envelope: JournalEnvelope;
  readonly classification: 'safe_replay' | 'already_applied' | 'diverged' | 'unknown_schema';
  readonly detail: string;
}

interface ClassifyCorrupt {
  readonly kind: 'corrupt';
  readonly detail: string;
}

type ClassifyOutcome = ClassifyOk | ClassifyCorrupt;

/**
 * Decision matrix for `rk recover --apply`. Conservative by default:
 *   - corrupt journal (parse fail, schema fail, content-hash tamper) → quarantine
 *   - unknown schema (parses but version unsupported) → leave pending, surface finding
 *   - diverged target (cur matches neither prev nor next) → quarantine
 *   - already applied (every cur === nextHash) → mark done, no mutation
 *   - safe replay (cur === prevHash for incomplete steps) → re-run primitives
 */
export async function classifyJournal(path: string): Promise<ClassifyOutcome> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    return { kind: 'corrupt', detail: `read failed: ${(cause as Error).message}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    return { kind: 'corrupt', detail: `JSON parse failed: ${(cause as Error).message}` };
  }
  const parsed = JournalEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: 'corrupt', detail: `schema validation failed: ${parsed.error.message}` };
  }
  const envelope = parsed.data;
  if (!isSupportedJournalSchemaVersion(envelope.schemaVersion)) {
    return {
      kind: 'ok',
      envelope,
      classification: 'unknown_schema',
      detail: `schemaVersion ${envelope.schemaVersion} is outside supported range — upgrade rk`,
    };
  }
  // Content-hash invariant: for write/atomic-create steps, sha256(content)
  // MUST equal nextHash. Mismatch means the journal itself is tampered;
  // refuse to apply it.
  for (const step of envelope.steps) {
    if (step.op === 'write' || step.op === 'atomic-create') {
      if (step.content === null || step.nextHash === null) {
        return {
          kind: 'corrupt',
          detail: `step ${step.stepIndex} (${step.op}) missing content or nextHash`,
        };
      }
      const expected = sha256Buffer(decodeContent(step.content, step.encoding));
      if (expected !== step.nextHash) {
        return {
          kind: 'corrupt',
          detail: `step ${step.stepIndex} content hash mismatch`,
        };
      }
    }
  }

  // Walk the steps to decide between SAFE_REPLAY / ALREADY_APPLIED / DIVERGED.
  let classification: 'safe_replay' | 'already_applied' = 'already_applied';
  for (const step of envelope.steps) {
    const cur = await sha256File(step.path);
    if (step.completedAt !== null && cur === step.nextHash) continue;
    if (cur === step.nextHash) continue; // already landed
    if (cur === step.prevHash) {
      classification = 'safe_replay';
      continue;
    }
    // Cache-invalidate steps store both hashes as null. Their pre/post state
    // is unobservable on the cache file, so we can always replay them safely.
    if (step.op === 'invalidate-cache' && step.prevHash === null && step.nextHash === null) {
      classification = 'safe_replay';
      continue;
    }
    return {
      kind: 'ok',
      envelope,
      classification: 'diverged',
      detail: `step ${step.stepIndex} (${step.op} ${step.path}): file diverged from both prev and next hashes`,
    };
  }
  return {
    kind: 'ok',
    envelope,
    classification,
    detail:
      classification === 'safe_replay'
        ? `${envelope.steps.filter((s) => s.completedAt === null).length} steps to replay`
        : 'all steps already applied',
  };
}

async function applyStep(step: JournalStep, opRoot: string): Promise<void> {
  switch (step.op) {
    case 'write': {
      if (step.content === null) throw new Error('write step missing content');
      await atomicWriteText(step.path, decodeContent(step.content, step.encoding).toString('utf8'));
      return;
    }
    case 'atomic-create': {
      if (step.content === null) throw new Error('atomic-create step missing content');
      try {
        await atomicCreateText(
          step.path,
          decodeContent(step.content, step.encoding).toString('utf8'),
        );
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException | undefined)?.code;
        // If the file already exists with the right content, treat as success.
        if (code === 'EEXIST') {
          const cur = await sha256File(step.path);
          if (cur === step.nextHash) return;
        }
        throw cause;
      }
      return;
    }
    case 'delete': {
      try {
        await unlink(step.path);
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException | undefined)?.code;
        if (code !== 'ENOENT') throw cause;
      }
      return;
    }
    case 'invalidate-cache': {
      await invalidatePreflightCache(opRoot);
      return;
    }
  }
}

async function quarantine(path: string): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, '');
  const rand = randomBytes(3).toString('hex');
  const dest = path.replace(/\.pending\.json$/, `.unrecoverable.${ts}.${rand}.json`);
  await rename(path, dest);
  return dest;
}

async function markAllStepsCompleted(envelope: JournalEnvelope): Promise<JournalEnvelope> {
  const now = new Date().toISOString();
  return {
    ...envelope,
    completedAt: now,
    steps: envelope.steps.map((s) => ({ ...s, completedAt: s.completedAt ?? now })),
  };
}

/**
 * Scan + heal pending journals under `<opRoot>/journal/`. Returns one
 * `JournalScanResult` per inspected pending file, regardless of `apply`.
 *
 * In `--preview` mode (apply=false) classification still happens but no
 * file is mutated, renamed, or quarantined. The caller decides whether to
 * surface findings as P1 to the operator.
 */
export async function scanAndHealJournals(opts: ScanAndHealOptions): Promise<JournalScanResult[]> {
  const pending = await listPendingJournals(opts.opRoot);
  const results: JournalScanResult[] = [];
  for (const path of pending) {
    const outcome = await classifyJournal(path);
    if (outcome.kind === 'corrupt') {
      const result: JournalScanResult = {
        opId: deriveOpIdFromPath(path),
        path,
        classification: 'corrupt',
        detail: outcome.detail,
        stepsApplied: 0,
        stepsAlreadyApplied: 0,
        ...(opts.apply ? { quarantinedPath: await quarantine(path) } : {}),
      };
      results.push(result);
      continue;
    }
    const { envelope, classification, detail } = outcome;
    if (classification === 'unknown_schema') {
      // Leave pending in place. Do not mutate, do not quarantine.
      results.push({
        opId: envelope.opId,
        path,
        classification,
        detail,
        stepsApplied: 0,
        stepsAlreadyApplied: 0,
      });
      continue;
    }
    if (classification === 'diverged') {
      results.push({
        opId: envelope.opId,
        path,
        classification,
        detail,
        stepsApplied: 0,
        stepsAlreadyApplied: 0,
        ...(opts.apply ? { quarantinedPath: await quarantine(path) } : {}),
      });
      continue;
    }
    if (!opts.apply) {
      // Preview: classify but do not mutate.
      const alreadyApplied = envelope.steps.filter((s) => s.completedAt !== null).length;
      const incomplete = envelope.steps.length - alreadyApplied;
      results.push({
        opId: envelope.opId,
        path,
        classification,
        detail,
        stepsApplied: 0,
        stepsAlreadyApplied: alreadyApplied,
        ...(classification === 'already_applied' ? {} : { stepsApplied: incomplete }),
      });
      continue;
    }
    // Apply path — re-run incomplete steps, then rename pending → done.
    let applied = 0;
    let alreadyApplied = 0;
    for (const step of envelope.steps) {
      const cur = await sha256File(step.path);
      if (step.completedAt !== null && cur === step.nextHash) {
        alreadyApplied += 1;
        continue;
      }
      if (cur === step.nextHash) {
        alreadyApplied += 1;
        continue;
      }
      // cur === prevHash (or invalidate-cache wildcard) — replay.
      await applyStep(step, opts.opRoot);
      applied += 1;
    }
    const completed = await markAllStepsCompleted(envelope);
    await atomicWriteText(path, `${JSON.stringify(completed, null, 2)}\n`);
    const donePath = path.replace(/\.pending\.json$/, '.done.json');
    await rename(path, donePath);
    results.push({
      opId: envelope.opId,
      path: donePath,
      classification,
      detail,
      stepsApplied: applied,
      stepsAlreadyApplied: alreadyApplied,
    });
  }
  return results;
}

function deriveOpIdFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? '';
  const m = base.match(/^(OP-[0-9A-HJKMNP-TV-Z]{26})\./);
  return m ? m[1] : 'OP-UNKNOWN';
}

/**
 * Best-effort retention sweep. Keeps the most recent `keep` `.done.json`
 * journals (lex order = ULID monotonic time order) and unlinks the tail.
 * Unrecoverable journals are never gc'd — they are forensic state.
 */
export async function gcJournals(opRoot: string, keep: number): Promise<number> {
  const dir = journalRoot(opRoot);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return 0;
    throw cause;
  }
  const done = entries.filter((f) => f.endsWith('.done.json')).sort();
  if (done.length <= keep) return 0;
  const toRemove = done.slice(0, done.length - keep);
  let removed = 0;
  for (const f of toRemove) {
    try {
      await unlink(join(dir, f));
      removed += 1;
    } catch {
      // ignore — best effort
    }
  }
  return removed;
}

// Internal exports for tests.
export const __test__ = {
  HEX_HASH_LEN,
  JOURNAL_LOCK,
  RETENTION_LIMIT,
};
