import { getCurrentSha, getDirtyFiles, stagePathsAndCommit } from './git.js';

export interface AutonomousCheckpointInput {
  readonly cwd: string;
  readonly sprintId: string;
  readonly allowedPaths: readonly string[];
  readonly generatedPaths: readonly string[];
}

export interface AutonomousCheckpoint {
  readonly sha: string;
  readonly files: readonly string[];
}

export async function checkpointAutonomousSprint(
  input: AutonomousCheckpointInput,
): Promise<AutonomousCheckpoint | null> {
  const dirty = await getDirtyFiles(input.cwd);
  const files = dirty.filter((file) =>
    isCheckpointPath(file, [...input.allowedPaths, ...input.generatedPaths]),
  );
  if (files.length === 0) return null;

  await stagePathsAndCommit(input.cwd, files, `chore(rk): checkpoint ${input.sprintId}`);
  return { sha: await getCurrentSha(input.cwd), files };
}

function isCheckpointPath(file: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => {
    const root = stripGlobTail(pattern);
    if (root.length === 0) return true;
    return file === root || file.startsWith(`${root}/`);
  });
}

function stripGlobTail(path: string): string {
  const index = path.search(/[*?{[]/u);
  const head = index === -1 ? path : path.slice(0, index);
  return head.replace(/\/$/, '');
}
