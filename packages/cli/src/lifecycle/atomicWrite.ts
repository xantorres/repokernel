import { link, open, rename, unlink } from 'node:fs/promises';

/**
 * Atomically replace `path` with `content`.
 *
 * Contract — this helper guarantees atomicity, not crash durability:
 *
 *   1. Open a sibling temp file `<path>.tmp.<pid>.<ts>.<rand>` with the
 *      `wx` (exclusive create) flag — fails if the temp already exists.
 *   2. Write the content, close the fd.
 *   3. Rename the temp over the target. POSIX rename is atomic on the
 *      same filesystem, which the sibling-temp approach guarantees.
 *
 * On any failure between steps 1 and 3 the temp file is unlinked. The
 * target is never opened for write directly, so a thrown write cannot
 * leave a half-written or empty target. Concurrent atomicWriteText calls
 * each create a unique temp and the last `rename` wins.
 *
 * Why no fsync: on macOS APFS (the dev/CI platform) the per-write fsync
 * cost ran the integration suite ~5× slower and drove the fakeAgent /
 * fastpath / e2eParallel tests over their 5s timeouts. The atomicity
 * property the master blueprint requires (no partial YAML, original
 * preserved on failure, temp cleaned up) is delivered by temp+rename
 * alone. Crash durability across a kernel-level crash is a separate
 * concern and is the recovery story owned by PR6 (`rk recover`).
 *
 * Not safe across filesystem boundaries — the temp must be on the same FS
 * as the target. By placing the temp in `dirname(path)` we satisfy that.
 */
export async function atomicWriteText(path: string, content: string): Promise<void> {
  const tempPath = makeTempPath(path);

  let writeOk = false;
  try {
    const fd = await open(tempPath, 'wx');
    try {
      await fd.writeFile(content, 'utf8');
    } finally {
      await fd.close();
    }
    await rename(tempPath, path);
    writeOk = true;
  } finally {
    if (!writeOk) {
      // Best-effort cleanup. ENOENT is expected if the rename succeeded
      // before we entered the catch path, or if `open` itself failed.
      await unlink(tempPath).catch(() => undefined);
    }
  }
}

function makeTempPath(target: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${target}.tmp.${process.pid}.${ts}.${rand}`;
}

/**
 * Atomically create `path` with `content`, failing fast if the target
 * already exists. Equivalent to `open(path, 'wx')` + `writeFile`, except
 * the content is fully written to a sibling temp first and only published
 * to the final path via `link()`. A crash, kill, or ENOSPC during the
 * write therefore cannot publish a half-written file at `path`.
 *
 * Sequence:
 *   1. Open a sibling temp `<path>.tmp.<pid>.<ts>.<rand>` with `wx`.
 *   2. Write content, close fd.
 *   3. `link(temp, path)` — atomic on the same filesystem; throws EEXIST
 *      if the target already exists. Callers detect EEXIST and treat it
 *      identically to the legacy `open(path, 'wx')` collision behavior.
 *   4. Always unlink the temp (whether the link succeeded or not).
 *
 * Same-FS constraint identical to atomicWriteText. Hard-links must be
 * supported by the filesystem (true on APFS, ext4, NTFS; false on some
 * FUSE mounts and exotic configs — those are out of scope for now).
 */
export async function atomicCreateText(path: string, content: string): Promise<void> {
  const tempPath = makeTempPath(path);
  let linkErr: unknown = null;
  try {
    const fd = await open(tempPath, 'wx');
    try {
      await fd.writeFile(content, 'utf8');
    } finally {
      await fd.close();
    }
    try {
      await link(tempPath, path);
    } catch (err) {
      linkErr = err;
    }
  } finally {
    // Temp is redundant once link succeeds; on link failure we leave no
    // residue. ENOENT is benign — temp may have been swept by something
    // external (rare) or never created (open threw).
    await unlink(tempPath).catch(() => undefined);
  }
  if (linkErr) throw linkErr;
}
