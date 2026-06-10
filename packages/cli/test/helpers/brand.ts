import type { EpicId, ReviewId, RunId, SprintId } from '@repokernel/core';

// Test-only brand casts: fixtures build ids from literals; the runtime value is
// a plain string, so a cast (not schema.parse) keeps fixtures free of regex
// constraints while satisfying the branded types.
export const sid = (s: string): SprintId => s as SprintId;
export const eid = (s: string): EpicId => s as EpicId;
export const rid = (s: string): ReviewId => s as ReviewId;
export const runId = (s: string): RunId => s as RunId;
