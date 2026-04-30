import { describe, expect, it } from 'vitest';
import { type Config, materialPaths } from '../src/index.js';

function configFor(paths: Partial<Config['paths']>): Config {
  const defaults: Config['paths'] = {
    epics: '.repokernel/plan/epics',
    sprints: '.repokernel/plan/sprints',
    reviews: '.repokernel/plan/reviews',
    queues: '.repokernel/plan/queues',
    lanes: '.repokernel/plan/lanes',
    generated: '.repokernel',
    registry: '.repokernel/registry.json',
  };
  return {
    schemaVersion: 1,
    projectId: 'test',
    projectName: 'test',
    paths: { ...defaults, ...paths },
    policies: {
      allowedStatuses: [
        'planned',
        'queued',
        'active',
        'review',
        'shipped',
        'cancelled',
        'reopened',
      ],
      requireReviewForShipped: true,
      requireBaseShaForActive: true,
      requireEndShaForShipped: true,
      allowMultipleActivePerLane: false,
      defaultLane: 'main',
      severityFailThreshold: 'P1',
      skippedSprintIds: [],
    },
    git: { requireCleanWorkingTreeForClose: true },
    generated: { files: [] },
    chaining: {
      enabled: false,
      maxSprintsPerRun: 1,
      requireReviewBetweenSprints: true,
      stopOnSeverity: 'P1',
      sameEpicOnly: true,
      sameLaneOnly: true,
    },
    worktrees: {
      root: '../.repokernel-worktrees',
      branchPrefix: 'rk/',
      baseBranch: 'main',
      autoAcquire: true,
    },
    automation: {
      allowAutonomousClose: false,
      defaultMode: 'assisted',
      defaultAgent: 'manual',
      checksTimeoutSeconds: 1800,
    },
    parallel: {
      maxConcurrentSprints: 4,
      conflictStrategy: 'block',
      allowOverlapFlag: false,
    },
    agents: {},
    routing: {
      tiers: ['light', 'standard', 'heavy'],
      rules: [],
    },
  } as Config;
}

describe('materialPaths', () => {
  it('returns the default RK layout with optional fields null', () => {
    const mp = materialPaths(configFor({}));
    expect(mp.epics).toBe('.repokernel/plan/epics');
    expect(mp.sprints).toBe('.repokernel/plan/sprints');
    expect(mp.reviews).toBe('.repokernel/plan/reviews');
    expect(mp.queues).toBe('.repokernel/plan/queues');
    expect(mp.lanes).toBe('.repokernel/plan/lanes');
    expect(mp.decisions).toBeNull();
    expect(mp.next).toBeNull();
    expect(mp.generated).toBe('.repokernel');
    expect(mp.registry).toBe('.repokernel/registry.json');
  });

  it('honours custom path layouts', () => {
    const mp = materialPaths(
      configFor({
        sprints: 'docs/sprints',
        reviews: 'docs/reviews',
        queues: '.queue',
        registry: 'state/registry.json',
        generated: 'state',
      }),
    );
    expect(mp.sprints).toBe('docs/sprints');
    expect(mp.reviews).toBe('docs/reviews');
    expect(mp.queues).toBe('.queue');
    expect(mp.registry).toBe('state/registry.json');
    expect(mp.generated).toBe('state');
  });

  it('exposes optional decisions and next when defined', () => {
    const mp = materialPaths(configFor({ decisions: 'docs/decisions', next: 'NEXT.md' }));
    expect(mp.decisions).toBe('docs/decisions');
    expect(mp.next).toBe('NEXT.md');
    expect(mp.all).toContain('docs/decisions');
    expect(mp.all).toContain('NEXT.md');
  });

  it('produces a worktreeStaged set covering every path the run pipeline may dirty', () => {
    const mp = materialPaths(
      configFor({
        sprints: 'docs/sprints',
        reviews: 'docs/reviews',
        queues: '.queue',
        decisions: 'docs/decisions',
        next: 'NEXT.md',
      }),
    );
    expect(mp.worktreeStaged).toContain('docs/sprints');
    expect(mp.worktreeStaged).toContain('docs/reviews');
    expect(mp.worktreeStaged).toContain('.queue');
    expect(mp.worktreeStaged).toContain('docs/decisions');
    expect(mp.worktreeStaged).toContain('NEXT.md');
    expect(mp.worktreeStaged).toContain('.repokernel/registry.json');
    expect(mp.worktreeStaged).toContain('.repokernel');
  });

  it('produces a mainStaged set covering every post-merge close-side mutation', () => {
    const mp = materialPaths(
      configFor({
        sprints: 'docs/sprints',
        reviews: 'docs/reviews',
        queues: '.queue',
        registry: '.repokernel/registry.json',
        generated: '.repokernel',
      }),
    );
    expect(mp.mainStaged).toContain('docs/sprints');
    expect(mp.mainStaged).toContain('docs/reviews');
    expect(mp.mainStaged).toContain('.queue');
    expect(mp.mainStaged).toContain('.repokernel/registry.json');
    expect(mp.mainStaged).toContain('.repokernel');
  });

  it('dedupes when generated equals registry parent or paths overlap', () => {
    const mp = materialPaths(
      configFor({ generated: '.repokernel', registry: '.repokernel/registry.json' }),
    );
    const counts = new Map<string, number>();
    for (const p of mp.all) counts.set(p, (counts.get(p) ?? 0) + 1);
    for (const [, count] of counts) expect(count).toBe(1);
  });

  it('keeps canonical ordering in `all` regardless of optional fields', () => {
    const mp = materialPaths(configFor({ decisions: 'docs/decisions', next: 'NEXT.md' }));
    const epicsIdx = mp.all.indexOf('.repokernel/plan/epics');
    const sprintsIdx = mp.all.indexOf('.repokernel/plan/sprints');
    const generatedIdx = mp.all.indexOf('.repokernel');
    expect(epicsIdx).toBeLessThan(sprintsIdx);
    expect(sprintsIdx).toBeLessThan(generatedIdx);
  });
});
