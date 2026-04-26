import { describe, expect, it } from 'vitest';
import {
  colorSprintStatus,
  epicIcon,
  progressBar,
  reviewIcon,
  sprintIcon,
} from '../src/format/progress.js';
import { padEnd, renderTable, stripAnsi, truncate, visualLen } from '../src/format/table.js';

// — progress bar —

describe('progressBar', () => {
  it('returns dashes for 0/0', () => {
    const result = progressBar(0, 0);
    expect(stripAnsi(result)).toMatch(/^─{10}/);
    expect(result).toContain('0/0');
  });

  it('renders fully filled bar for 3/3', () => {
    const result = progressBar(3, 3);
    expect(stripAnsi(result)).toMatch(/^█{10}/);
    expect(result).toContain('3/3');
  });

  it('renders correct ratio for 2/10', () => {
    const result = progressBar(2, 10);
    const plain = stripAnsi(result);
    expect(plain.startsWith('██')).toBe(true);
    expect(plain).toContain('2/10');
  });

  it('renders 0/5 as all empty', () => {
    const result = progressBar(0, 5);
    const plain = stripAnsi(result);
    expect(plain.startsWith('░')).toBe(true);
    expect(plain).toContain('0/5');
  });

  it('respects custom barWidth', () => {
    const result = progressBar(5, 10, 5);
    const plain = stripAnsi(result);
    const barPart = plain.split('  ')[0]!;
    expect(barPart.length).toBe(5);
  });
});

// — icons —

describe('sprintIcon', () => {
  it('maps all known statuses', () => {
    expect(sprintIcon('shipped')).toBe('■');
    expect(sprintIcon('active')).toBe('▶');
    expect(sprintIcon('review')).toBe('◆');
    expect(sprintIcon('queued')).toBe('○');
    expect(sprintIcon('planned')).toBe('·');
    expect(sprintIcon('pending')).toBe('·');
    expect(sprintIcon('reopened')).toBe('↺');
    expect(sprintIcon('cancelled')).toBe('✗');
  });
});

describe('epicIcon', () => {
  it('maps all known statuses', () => {
    expect(epicIcon('done')).toBe('■');
    expect(epicIcon('active')).toBe('▶');
    expect(epicIcon('on_hold')).toBe('◆');
    expect(epicIcon('planned')).toBe('·');
    expect(epicIcon('cancelled')).toBe('✗');
  });
});

describe('reviewIcon', () => {
  it('maps all known verdicts', () => {
    expect(reviewIcon('accepted')).toBe('✓');
    expect(reviewIcon('pending')).toBe('◆');
    expect(reviewIcon('changes_requested')).toBe('↺');
    expect(reviewIcon('rejected')).toBe('✗');
  });
});

describe('colorSprintStatus', () => {
  it('output contains the status string', () => {
    for (const status of [
      'shipped',
      'active',
      'review',
      'queued',
      'planned',
      'pending',
      'reopened',
      'cancelled',
    ] as const) {
      expect(stripAnsi(colorSprintStatus(status))).toContain(status);
    }
  });
});

// — table helpers —

describe('stripAnsi', () => {
  it('removes ANSI escape codes', () => {
    expect(stripAnsi('\x1b[32mhello\x1b[0m')).toBe('hello');
    expect(stripAnsi('plain')).toBe('plain');
  });
});

describe('visualLen', () => {
  it('measures visible length, not byte length', () => {
    expect(visualLen('\x1b[32mhello\x1b[0m')).toBe(5);
    expect(visualLen('abc')).toBe(3);
  });
});

describe('padEnd', () => {
  it('pads plain string', () => {
    expect(padEnd('hi', 5)).toBe('hi   ');
  });

  it('pads colored string by visual length', () => {
    const colored = '\x1b[32mhi\x1b[0m'; // "hi" in green
    const result = padEnd(colored, 5);
    expect(visualLen(result)).toBe(5);
  });

  it('does not truncate if already wider', () => {
    expect(padEnd('hello', 3)).toBe('hello');
  });
});

describe('truncate', () => {
  it('leaves short strings untouched', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('clips and appends ellipsis', () => {
    const result = truncate('hello world', 8);
    expect(visualLen(result)).toBe(8);
    expect(result.endsWith('…')).toBe(true);
  });
});

// — renderTable —

describe('renderTable', () => {
  const cols = [
    { key: 'id', header: 'ID' },
    { key: 'title', header: 'TITLE' },
  ] as const;

  it('renders header + separator + rows', () => {
    const rows = [
      { id: 'E-001', title: 'Core Validator' },
      { id: 'E-002', title: 'Queue Import' },
    ];
    const out = renderTable(rows, cols);
    expect(out).toContain('ID');
    expect(out).toContain('TITLE');
    expect(out).toContain('─');
    expect(out).toContain('E-001');
    expect(out).toContain('Core Validator');
  });

  it('auto-widens columns to max content', () => {
    const rows = [{ id: 'E-001', title: 'A very long title here' }];
    const out = renderTable(rows, cols);
    const lines = out.split('\n');
    // all lines should have same visual length (header, sep, data)
    const lengths = lines.map((l) => visualLen(l));
    expect(lengths[0]).toBe(lengths[2]);
  });

  it('handles empty rows', () => {
    const out = renderTable([], cols);
    expect(out).toContain('ID');
    expect(out).toContain('TITLE');
  });

  it('applies render function for coloring without breaking alignment', () => {
    const colorCols = [
      { key: 'id', header: 'ID', render: (v: string) => `\x1b[32m${v}\x1b[0m` },
      { key: 'title', header: 'TITLE' },
    ] as const;
    const rows = [{ id: 'E-001', title: 'Core' }];
    const out = renderTable(rows, colorCols);
    const lines = out.split('\n');
    // visual length of header and data row should match
    expect(visualLen(lines[0]!)).toBe(visualLen(lines[2]!));
  });

  it('right-aligns when align is right', () => {
    const rightCols = [{ key: 'n', header: 'N', align: 'right' as const }];
    const rows = [{ n: '5' }, { n: '123' }];
    const out = renderTable(rows, rightCols);
    const lines = out.split('\n');
    expect(lines[2]!.trimStart()).toBe('5');
    expect(lines[3]!.trimStart()).toBe('123');
  });
});
