import { resolve } from 'node:path';
import type { Sprint, SprintStatus } from '@repokernel/core';
import { loadProject, RepoKernelError } from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { padEnd, truncate } from '../format/table.js';
import type { CommandResult } from './validate.js';

export interface BoardOptions {
  readonly cwd: string;
  readonly epic?: string;
  readonly lane?: string;
  readonly showCancelled: boolean;
  readonly json: boolean;
}

const COLUMN_ORDER: SprintStatus[] = ['planned', 'queued', 'active', 'review', 'shipped'];
const CARD_WIDTH = 20;
const COL_GAP = '  ';

export async function runBoardCommand(opts: BoardOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) {
      return {
        exitCode: EXIT_RUNTIME,
        stdout: '',
        stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
      };
    }

    let sprints = [...outcome.graph.sprints.values()];

    if (opts.epic !== undefined) {
      const epicSprints = new Set(outcome.graph.sprintsByEpic.get(opts.epic) ?? []);
      sprints = sprints.filter((s) => epicSprints.has(s.id));
    }
    if (opts.lane !== undefined) {
      sprints = sprints.filter((s) => s.lane === opts.lane);
    }

    const columns = buildColumns(sprints, opts.showCancelled);

    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: `${JSON.stringify(
          {
            columns: Object.fromEntries(
              Object.entries(columns).map(([k, v]) => [k, v.map(serializeSprint)]),
            ),
            filters: {
              epic: opts.epic ?? null,
              lane: opts.lane ?? null,
            },
          },
          null,
          2,
        )}\n`,
        stderr: '',
      };
    }

    const statuses = opts.showCancelled
      ? [...COLUMN_ORDER, 'cancelled' as SprintStatus]
      : COLUMN_ORDER;
    const out = renderBoard(columns, statuses);
    return { exitCode: EXIT_OK, stdout: out, stderr: '' };
  } catch (e) {
    if (e instanceof RepoKernelError)
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    throw e;
  }
}

type Columns = Record<SprintStatus, Sprint[]>;

function buildColumns(sprints: Sprint[], showCancelled: boolean): Columns {
  const cols: Columns = {
    planned: [],
    pending: [],
    queued: [],
    active: [],
    review: [],
    shipped: [],
    reopened: [],
    cancelled: [],
  };
  for (const s of sprints) {
    cols[s.status].push(s);
  }
  // merge pending into planned for display — they're pre-queue states
  cols.planned.push(...cols.pending);
  cols.planned.sort((a, b) => a.id.localeCompare(b.id));

  for (const key of Object.keys(cols) as SprintStatus[]) {
    cols[key].sort((a, b) => a.id.localeCompare(b.id));
  }

  if (!showCancelled) cols.cancelled = [];

  return cols;
}

function renderBoard(columns: Columns, statuses: SprintStatus[]): string {
  const headerLine = statuses
    .map((s) => {
      const label = s.toUpperCase();
      return padEnd(label, CARD_WIDTH);
    })
    .join(COL_GAP);

  const sepLine = statuses.map(() => '─'.repeat(CARD_WIDTH)).join(COL_GAP);

  const maxCards = Math.max(...statuses.map((s) => columns[s].length), 0);
  if (maxCards === 0) {
    const emptyRow = statuses.map(() => padEnd(pc.dim('(empty)'), CARD_WIDTH)).join(COL_GAP);
    return [headerLine, sepLine, emptyRow, ''].join('\n');
  }

  // Each card is 3 lines tall; columns separated by a blank line between cards
  const rowGroups: string[][] = [];

  for (let i = 0; i < maxCards; i++) {
    // 3 lines per card row
    const line1Parts: string[] = [];
    const line2Parts: string[] = [];
    const line3Parts: string[] = [];

    for (const status of statuses) {
      const card = columns[status][i];
      if (card) {
        line1Parts.push(padEnd(`${card.id}  ${card.epic_id}`, CARD_WIDTH));
        line2Parts.push(padEnd(truncate(card.title, CARD_WIDTH), CARD_WIDTH));
        line3Parts.push(padEnd(pc.dim(truncate(card.lane, CARD_WIDTH)), CARD_WIDTH));
      } else {
        line1Parts.push(' '.repeat(CARD_WIDTH));
        line2Parts.push(' '.repeat(CARD_WIDTH));
        line3Parts.push(' '.repeat(CARD_WIDTH));
      }
    }

    rowGroups.push([line1Parts.join(COL_GAP), line2Parts.join(COL_GAP), line3Parts.join(COL_GAP)]);
  }

  const cardRows = rowGroups.map((g) => g.join('\n')).join('\n\n');
  return [headerLine, sepLine, cardRows, ''].join('\n');
}

function serializeSprint(s: Sprint) {
  return { id: s.id, title: s.title, status: s.status, lane: s.lane, epic_id: s.epic_id };
}
