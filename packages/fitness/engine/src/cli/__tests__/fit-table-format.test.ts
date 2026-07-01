/**
 * Regression tests for the fitness results-table helpers shared between the
 * live Ink view and envelope-derived static tables.
 */
import { describe, expect, it } from 'vitest';

import {
  formatValidatedColumn,
  parseValidatedCount,
  sortFitRowPriority,
} from '../fit-table-format.js';

describe('sortFitRowPriority', () => {
  it('orders timeout/error before fail before warned pass before clean pass', () => {
    expect(sortFitRowPriority({ status: 'TIMEOUT', warnings: 0 })).toBe(0);
    expect(sortFitRowPriority({ status: 'FAIL', warnings: 0 })).toBe(1);
    expect(sortFitRowPriority({ status: 'PASS', warnings: 3 })).toBe(2);
    expect(sortFitRowPriority({ status: 'PASS', warnings: 0 })).toBe(3);
  });

  it('ignores warnings when status is already fail or timeout', () => {
    expect(sortFitRowPriority({ status: 'FAIL', warnings: 5 })).toBe(1);
    expect(sortFitRowPriority({ status: 'TIMEOUT', warnings: 5 })).toBe(0);
  });

  it('sorts a mixed list into the canonical priority order', () => {
    const rows = [
      { status: 'PASS' as const, warnings: 0 },
      { status: 'FAIL' as const, warnings: 0 },
      { status: 'PASS' as const, warnings: 2 },
      { status: 'TIMEOUT' as const, warnings: 0 },
    ];
    const sorted = [...rows].sort((a, b) => sortFitRowPriority(a) - sortFitRowPriority(b));
    expect(sorted.map((r) => r.status)).toEqual(['TIMEOUT', 'FAIL', 'PASS', 'PASS']);
  });
});

describe('parseValidatedCount', () => {
  it('extracts the leading integer from a validated cell', () => {
    expect(parseValidatedCount('171 files')).toBe(171);
    expect(parseValidatedCount('1103 files')).toBe(1103);
  });

  it('returns 0 for em-dash and unparseable cells', () => {
    expect(parseValidatedCount('—')).toBe(0);
    expect(parseValidatedCount('no count here')).toBe(0);
    expect(parseValidatedCount('')).toBe(0);
  });
});

describe('formatValidatedColumn', () => {
  it('formats singular and plural item nouns', () => {
    expect(formatValidatedColumn(1, 'files')).toBe('1 file');
    expect(formatValidatedColumn(450, 'files')).toBe('450 files');
    expect(formatValidatedColumn(0)).toBe('—');
    expect(formatValidatedColumn(undefined)).toBe('—');
  });
});
