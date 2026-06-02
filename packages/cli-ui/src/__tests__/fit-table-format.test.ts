/**
 * Shared fit results-table helpers — used by both the cli static view-model
 * (fit-done-view) and the fitness live Ink view (fit-runner-views), so their
 * behavior is pinned once here.
 */

import { describe, it, expect } from 'vitest';

import { sortFitRowPriority, parseValidatedCount } from '../fit-table-format.js';

describe('sortFitRowPriority', () => {
  it('orders timeout < fail < has-warnings < clean', () => {
    expect(sortFitRowPriority({ status: 'TIMEOUT', warnings: 0 })).toBe(0);
    expect(sortFitRowPriority({ status: 'FAIL', warnings: 0 })).toBe(1);
    expect(sortFitRowPriority({ status: 'PASS', warnings: 3 })).toBe(2);
    expect(sortFitRowPriority({ status: 'PASS', warnings: 0 })).toBe(3);
  });

  it('prioritizes status over warnings (a failing check with warnings is still FAIL-tier)', () => {
    expect(sortFitRowPriority({ status: 'FAIL', warnings: 5 })).toBe(1);
    expect(sortFitRowPriority({ status: 'TIMEOUT', warnings: 5 })).toBe(0);
  });

  it('sorts a mixed set into timeout, fail, warnings, clean order', () => {
    const rows = [
      { status: 'PASS' as const, warnings: 0 },
      { status: 'FAIL' as const, warnings: 0 },
      { status: 'PASS' as const, warnings: 1 },
      { status: 'TIMEOUT' as const, warnings: 0 },
    ];
    const sorted = [...rows].sort((a, b) => sortFitRowPriority(a) - sortFitRowPriority(b));
    expect(sorted.map((r) => r.status)).toEqual(['TIMEOUT', 'FAIL', 'PASS', 'PASS']);
    expect(sorted[2]?.warnings).toBe(1); // the warning row sorts before the clean one
  });
});

describe('parseValidatedCount', () => {
  it('parses the leading integer from a "N files" cell', () => {
    expect(parseValidatedCount('171 files')).toBe(171);
    expect(parseValidatedCount('1103 files')).toBe(1103);
  });

  it('returns 0 for the em-dash placeholder', () => {
    expect(parseValidatedCount('—')).toBe(0);
  });

  it('returns 0 when there is no leading number', () => {
    expect(parseValidatedCount('no count here')).toBe(0);
    expect(parseValidatedCount('')).toBe(0);
  });
});
