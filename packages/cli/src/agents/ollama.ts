import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentRunner, SprintRunInput, SprintRunResult } from './types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3.1';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min — local CPUs are slow on long prompts

const MAX_CONTEXT_FILES = 20;
const MAX_CONTEXT_BYTES_PER_FILE = 4000;

const SYSTEM_PROMPT = `You are a coding agent operating inside an isolated Git worktree.

The user will give you a task and a list of files. You must respond with ONLY a valid JSON object — no markdown fences, no commentary, no extra text.

Required JSON shape:
{
  "summary": "<one short sentence describing what you did>",
  "files": [
    { "path": "<relative path>", "content": "<full new file contents>" }
  ]
}

Rules:
- Each entry in "files" REPLACES the entire file at that path. To leave a file untouched, omit it.
- Paths are relative to the worktree root. No leading slash, no ".." segments, no absolute paths.
- Make the smallest set of changes that satisfies the task.
- If you cannot complete the task safely, respond with: {"summary": "<reason>", "files": []}
`;

interface OllamaConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
}

function readOllamaConfig(): OllamaConfig {
  const baseUrl = process.env.OLLAMA_HOST ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL;
  const model = process.env.OLLAMA_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = process.env.OLLAMA_TIMEOUT_MS
    ? Math.max(1000, Number.parseInt(process.env.OLLAMA_TIMEOUT_MS, 10))
    : DEFAULT_TIMEOUT_MS;
  return { baseUrl: baseUrl.replace(/\/$/, ''), model, timeoutMs };
}

async function callOllamaChat(config: OllamaConfig, prompt: string): Promise<string> {
  const url = `${config.baseUrl}/api/chat`;
  const body = {
    model: config.model,
    stream: false,
    format: 'json',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Ollama returned ${res.status} ${res.statusText}: ${errText.slice(0, 300)}`);
    }
    const data = (await res.json()) as { message?: { content?: string } };
    const content = data?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('Ollama response missing message.content');
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

interface ModelResponse {
  readonly summary: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
}

function parseModelResponse(raw: string): ModelResponse {
  // Even with `format: 'json'`, smaller models occasionally wrap in fences.
  const candidate = stripCodeFences(raw.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new Error(
      `Ollama response is not valid JSON (${(err as Error).message}); first 200 chars: ${candidate.slice(0, 200)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Ollama response is not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;

  const summary =
    typeof obj.summary === 'string' && obj.summary.trim().length > 0
      ? obj.summary.trim()
      : 'No summary provided by model.';

  const filesRaw = Array.isArray(obj.files) ? obj.files : [];
  const files = filesRaw
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .map((f) => ({
      path: typeof f.path === 'string' ? f.path.trim() : '',
      content: typeof f.content === 'string' ? f.content : '',
    }))
    .filter((f) => f.path.length > 0);

  return { summary, files };
}

function stripCodeFences(s: string): string {
  const m = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  return m?.[1] ?? s;
}

function isPathSafe(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith('/')) return false;
  const segments = p.split(/[\\/]/);
  if (segments.includes('..')) return false;
  if (segments.includes('.git')) return false;
  return true;
}

async function gatherWorktreeContext(worktree: string): Promise<string> {
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync('git', ['-C', worktree, 'ls-files']));
  } catch {
    return '(worktree has no tracked files yet)';
  }
  const files = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_CONTEXT_FILES);
  if (files.length === 0) return '(worktree has no tracked files yet)';

  const sections: string[] = [];
  for (const f of files) {
    try {
      const content = await readFile(join(worktree, f), 'utf8');
      const truncated =
        content.length > MAX_CONTEXT_BYTES_PER_FILE
          ? `${content.slice(0, MAX_CONTEXT_BYTES_PER_FILE)}\n... (${content.length - MAX_CONTEXT_BYTES_PER_FILE} more bytes truncated)`
          : content;
      sections.push(`--- ${f} ---\n${truncated}`);
    } catch {
      // skip binary or unreadable files
    }
  }
  return sections.join('\n\n');
}

function buildPrompt(packet: string, context: string): string {
  return [
    'TASK',
    '====',
    packet.trim(),
    '',
    'CURRENT FILES IN WORKTREE',
    '=========================',
    context,
    '',
    'Reply with the JSON object described in the system prompt. No other text.',
  ].join('\n');
}

function fail(summary: string): SprintRunResult {
  return { status: 'failed', summary, changed_files: [], needs_human: true };
}

function blocked(summary: string): SprintRunResult {
  return { status: 'blocked', summary, changed_files: [], needs_human: true };
}

/**
 * Local-first agent runner backed by an Ollama HTTP endpoint.
 *
 * Single-turn protocol:
 *   1. Read the sprint packet (the task description RepoKernel hands the agent).
 *   2. Read up to {@link MAX_CONTEXT_FILES} tracked files from the worktree.
 *   3. POST a chat completion request to `${OLLAMA_HOST}/api/chat` with
 *      `format: 'json'` so even small models tend to emit valid JSON.
 *   4. Parse the response into a `{ summary, files: [{path, content}] }` shape.
 *   5. Write each returned file (whole-file replacement) inside the worktree.
 *   6. `git add` + `git commit` the changed files.
 *
 * Limitations (documented for users in `docs/fastpath.md`):
 *   - Whole-file replacement only — small models struggle with reliable diffs.
 *   - Single-turn — no retry / no tool use / no iterative refinement.
 *   - Quality scales with the model — Llama 3.1 8B works for trivial tasks,
 *     real production work needs a larger model or a richer agent.
 */
export class OllamaRunner implements AgentRunner {
  readonly name = 'ollama';

  async runSprint(input: SprintRunInput): Promise<SprintRunResult> {
    const config = readOllamaConfig();

    let packet = '';
    try {
      packet = await readFile(input.sprint_packet_path, 'utf8');
    } catch (err) {
      return fail(`Could not read sprint packet: ${(err as Error).message}`);
    }

    const context = await gatherWorktreeContext(input.worktree);
    const prompt = buildPrompt(packet, context);

    let raw: string;
    try {
      raw = await callOllamaChat(config, prompt);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('aborted') || (err as Error).name === 'AbortError') {
        return fail(
          `Ollama request timed out after ${config.timeoutMs}ms — set OLLAMA_TIMEOUT_MS higher or use a smaller model`,
        );
      }
      return fail(
        `Ollama call failed: ${message}. Is ollama running at ${config.baseUrl}? (set OLLAMA_HOST to override)`,
      );
    }

    let modelResponse: ModelResponse;
    try {
      modelResponse = parseModelResponse(raw);
    } catch (err) {
      return fail((err as Error).message);
    }

    if (modelResponse.files.length === 0) {
      return blocked(modelResponse.summary);
    }

    const changedFiles: string[] = [];
    for (const f of modelResponse.files) {
      if (!isPathSafe(f.path)) {
        return fail(`Model proposed unsafe path: "${f.path}"`);
      }
      const fullPath = join(input.worktree, f.path);
      try {
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, f.content, 'utf8');
        changedFiles.push(f.path);
      } catch (err) {
        return fail(`Could not write ${f.path}: ${(err as Error).message}`);
      }
    }

    try {
      await execFileAsync('git', ['-C', input.worktree, 'add', '--', ...changedFiles]);
      await execFileAsync('git', [
        '-C',
        input.worktree,
        'commit',
        '-m',
        `feat(${input.sprint_id}): ollama ${config.model}`,
      ]);
    } catch (err) {
      return fail(`git commit failed: ${(err as Error).message}`);
    }

    return {
      status: 'completed',
      summary: modelResponse.summary,
      changed_files: changedFiles,
      needs_human: input.mode === 'assisted',
      ...(input.mode === 'autonomous' && {
        review: { verdict: 'accepted' as const, findings: [] },
      }),
    };
  }
}
