import { describe, expect, it } from 'vitest';
import { pickAutoLane } from '../src/lifecycle/laneResolve.js';

describe('pickAutoLane', () => {
  it('prefers the default lane when it is free', () => {
    const r = pickAutoLane(['main', 'ui'], new Set(['ui']), 'main');
    expect(r).toEqual({ lane: 'main', fellBackToDefault: false });
  });

  it('skips the default lane when it is busy and picks the first free lane', () => {
    const r = pickAutoLane(['main', 'ui'], new Set(['main']), 'main');
    expect(r).toEqual({ lane: 'ui', fellBackToDefault: false });
  });

  it('picks the alphabetically-first free lane deterministically', () => {
    const r = pickAutoLane(['main', 'review', 'ui'], new Set(['main']), 'main');
    expect(r.lane).toBe('review');
    expect(r.fellBackToDefault).toBe(false);
  });

  it('falls back to the default lane and flags it when every lane is busy', () => {
    const r = pickAutoLane(['main', 'ui'], new Set(['main', 'ui']), 'main');
    expect(r).toEqual({ lane: 'main', fellBackToDefault: true });
  });

  it('falls back to the default lane when no lanes are known', () => {
    const r = pickAutoLane([], new Set(['main']), 'main');
    expect(r).toEqual({ lane: 'main', fellBackToDefault: true });
  });

  it('uses the default lane when it is the only known lane and is free', () => {
    const r = pickAutoLane(['main'], new Set(), 'main');
    expect(r).toEqual({ lane: 'main', fellBackToDefault: false });
  });
});
