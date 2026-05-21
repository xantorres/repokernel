import { describe, expect, it } from 'vitest';
import { defaultDirectoryGlob } from '../src/commands/create.js';

describe('defaultDirectoryGlob', () => {
  it('adds the common parent directory when every entry is a concrete file under it', () => {
    const result = defaultDirectoryGlob(['src/foo.ts', 'src/bar.ts']);
    expect(result.added).toBe('src');
    expect(result.paths).toContain('src');
    expect(result.paths).toContain('src/foo.ts');
  });

  it('adds the parent directory for a single concrete file', () => {
    const result = defaultDirectoryGlob(['src/components/widget.tsx']);
    expect(result.added).toBe('src/components');
    expect(result.paths).toEqual(['src/components/widget.tsx', 'src/components']);
  });

  it('leaves entries verbatim when an explicit glob is present', () => {
    const input = ['src/**/*.ts', 'src/foo.ts'];
    const result = defaultDirectoryGlob(input);
    expect(result.added).toBeNull();
    expect(result.paths).toBe(input);
  });

  it('leaves entries verbatim when a directory entry is present', () => {
    const input = ['src/', 'src/foo.ts'];
    const result = defaultDirectoryGlob(input);
    expect(result.added).toBeNull();
    expect(result.paths).toBe(input);
  });

  it('leaves entries verbatim when files have different parent directories', () => {
    const input = ['src/a/foo.ts', 'src/b/bar.ts'];
    const result = defaultDirectoryGlob(input);
    expect(result.added).toBeNull();
    expect(result.paths).toBe(input);
  });

  it('leaves entries verbatim for extension-less files', () => {
    const input = ['scripts/build', 'scripts/deploy'];
    const result = defaultDirectoryGlob(input);
    expect(result.added).toBeNull();
    expect(result.paths).toBe(input);
  });

  it('does not widen to everything for repo-root files', () => {
    const input = ['index.ts'];
    const result = defaultDirectoryGlob(input);
    expect(result.added).toBeNull();
    expect(result.paths).toBe(input);
  });

  it('returns an empty input unchanged', () => {
    const result = defaultDirectoryGlob([]);
    expect(result.added).toBeNull();
    expect(result.paths).toEqual([]);
  });
});
