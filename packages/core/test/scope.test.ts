import { describe, expect, it } from 'vitest';
import { resolveNextRunnableSprint } from '../src/resolver/index.js';

describe('resolveNextRunnableSprint epic-aware finding filter', () => {
  it('ignores sibling-epic findings when --epic is set', () => {
    const epic = (id: string) => ({ id, sprints: [`S-${id.slice(2)}1`] }) as never;
    const sprint = (id: string, lane: string, epicId: string, status: string) =>
      ({
        id,
        lane,
        epic_id: epicId,
        status,
        depends_on: [],
        blocked_by: [],
        gate: undefined,
      }) as never;
    const graph = {
      epics: new Map([
        ['E-001', epic('E-001')],
        ['E-002', epic('E-002')],
      ]),
      sprints: new Map([
        ['S-011', sprint('S-011', 'main', 'E-001', 'queued')],
        ['S-021', sprint('S-021', 'main', 'E-002', 'queued')],
      ]),
      reviews: new Map(),
      queuesByLane: new Map([
        [
          'main',
          [
            { id: 'Q-001', sprint_id: 'S-011', order: 0 },
            { id: 'Q-002', sprint_id: 'S-021', order: 1 },
          ],
        ],
      ]),
    } as never;
    const config = {
      policies: {
        defaultLane: 'main',
        severityFailThreshold: 'P1',
        allowMultipleActivePerLane: false,
      },
    } as never;
    // P0 against S-021 (E-002). With --epic E-001 set, this should NOT
    // block resolution of S-011 even though both sprints share the lane.
    const findings = [
      {
        severity: 'P0',
        code: 'TEST',
        message: 'sibling epic blocker',
        entityType: 'sprint',
        entityId: 'S-021',
      },
    ] as never;
    const result = resolveNextRunnableSprint(graph, config, findings, { epicId: 'E-001' });
    expect(result.result).toBe('runnable');
    expect(result.sprintId).toBe('S-011');
  });

  it('still blocks when the finding is in the target epic', () => {
    const sprint = (id: string, lane: string, epicId: string, status: string) =>
      ({
        id,
        lane,
        epic_id: epicId,
        status,
        depends_on: [],
        blocked_by: [],
        gate: undefined,
      }) as never;
    const graph = {
      epics: new Map([['E-001', { id: 'E-001', sprints: ['S-011'] } as never]]),
      sprints: new Map([['S-011', sprint('S-011', 'main', 'E-001', 'queued')]]),
      reviews: new Map(),
      queuesByLane: new Map([['main', [{ id: 'Q-001', sprint_id: 'S-011', order: 0 }]]]),
    } as never;
    const config = {
      policies: {
        defaultLane: 'main',
        severityFailThreshold: 'P1',
        allowMultipleActivePerLane: false,
      },
    } as never;
    const findings = [
      {
        severity: 'P0',
        code: 'TEST',
        message: 'own epic blocker',
        entityType: 'sprint',
        entityId: 'S-011',
      },
    ] as never;
    const result = resolveNextRunnableSprint(graph, config, findings, { epicId: 'E-001' });
    expect(result.result).toBe('blocked');
  });
});
