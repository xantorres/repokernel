/** Sprint/task bodies are prose, not payloads — 1 MB is a generous ceiling. */
const MAX_STDIN_BYTES = 1024 * 1024;

/**
 * Read all of stdin into a UTF-8 string, capped so an unbounded pipe (or a
 * misrouted file) cannot exhaust the process heap. Throws once the cap is
 * exceeded. In an interactive TTY with nothing piped this blocks until EOF —
 * callers that read stdin should only do so when the user opted in (e.g. `-`).
 */
export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > MAX_STDIN_BYTES) {
      throw new Error(`stdin input exceeds the ${MAX_STDIN_BYTES / 1024}KB limit`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}
