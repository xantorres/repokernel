import { RepoKernelError } from '@repokernel/core';
import { describe, expect, it } from 'vitest';
import { parseTrackerRef } from '../../src/trackers/parseRef.js';

describe('parseTrackerRef', () => {
  it('accepts valid gh refs', () => {
    expect(parseTrackerRef('gh:owner/repo#123')).toEqual({
      source: 'gh',
      ref: 'owner/repo#123',
    });
    expect(parseTrackerRef('gh:acme-org/web-app#1631')).toEqual({
      source: 'gh',
      ref: 'acme-org/web-app#1631',
    });
  });

  it('accepts valid jira refs', () => {
    expect(parseTrackerRef('jira:ACM-2293')).toEqual({
      source: 'jira',
      ref: 'ACM-2293',
    });
    expect(parseTrackerRef('jira:KEY-1')).toEqual({ source: 'jira', ref: 'KEY-1' });
  });

  it('accepts valid linear refs', () => {
    expect(parseTrackerRef('linear:ABC-12')).toEqual({ source: 'linear', ref: 'ABC-12' });
    expect(parseTrackerRef('linear:TMS-9999')).toEqual({
      source: 'linear',
      ref: 'TMS-9999',
    });
  });

  it('rejects malformed gh refs', () => {
    expect(() => parseTrackerRef('gh:not-a-repo')).toThrow(RepoKernelError);
    expect(() => parseTrackerRef('gh:owner/repo')).toThrow(/owner\/repo#NNN/);
    expect(() => parseTrackerRef('gh:#123')).toThrow(RepoKernelError);
    expect(() => parseTrackerRef('gh:owner/repo#abc')).toThrow(RepoKernelError);
  });

  it('rejects malformed jira refs', () => {
    expect(() => parseTrackerRef('jira:lowercase-1')).toThrow(/KEY-NNN/);
    expect(() => parseTrackerRef('jira:KEY')).toThrow(RepoKernelError);
    expect(() => parseTrackerRef('jira:123-KEY')).toThrow(RepoKernelError);
  });

  it('rejects malformed linear refs', () => {
    expect(() => parseTrackerRef('linear:abc-12')).toThrow(/ABC-NNN/);
    expect(() => parseTrackerRef('linear:TEAM')).toThrow(RepoKernelError);
  });

  it('rejects unknown sources', () => {
    expect(() => parseTrackerRef('asana:TASK-1')).toThrow(RepoKernelError);
    expect(() => parseTrackerRef('notion:abc')).toThrow(RepoKernelError);
  });

  it('rejects malformed input lacking colon', () => {
    expect(() => parseTrackerRef('plain-text')).toThrow(/malformed/);
    expect(() => parseTrackerRef('')).toThrow(/malformed/);
  });

  it('rejects empty ref after colon', () => {
    expect(() => parseTrackerRef('jira:')).toThrow(/malformed/);
  });
});
