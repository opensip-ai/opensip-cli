import { describe, expect, it } from 'vitest';

import { formatSignalTableRows, formatSignalTableSummary } from '../signal-table.js';
import { EMPTY_ENVELOPE, FIXTURE_ENVELOPE } from './fixtures.js';

import type { SignalEnvelope } from '@opensip-tools/contracts';

describe('formatSignalTableRows', () => {
  it('derives one row per unit (snapshot)', () => {
    expect(formatSignalTableRows(FIXTURE_ENVELOPE)).toMatchSnapshot();
  });

  it('attributes signals to units by source and counts error/warning rungs', () => {
    const rows = formatSignalTableRows(FIXTURE_ENVELOPE);
    expect(rows).toHaveLength(2);

    const orphan = rows.find((r) => r.unit === 'graph:orphan-subtree');
    expect(orphan).toMatchObject({ status: 'FAIL', errors: 1, warnings: 0 });

    const large = rows.find((r) => r.unit === 'graph:large-function');
    // unit.passed === true → PASS even though it carries one medium signal.
    expect(large).toMatchObject({ status: 'PASS', errors: 0, warnings: 1 });
  });

  it('formats durations and preserves raw ms', () => {
    const rows = formatSignalTableRows(FIXTURE_ENVELOPE);
    expect(rows[0]).toMatchObject({ duration: '12ms', durationMs: 12 });
  });

  it('marks an errored unit as ERROR and surfaces its message', () => {
    const env: SignalEnvelope = {
      ...EMPTY_ENVELOPE,
      units: [{ slug: 'boom', passed: false, durationMs: 3, error: 'parse failed' }],
    };
    const rows = formatSignalTableRows(env);
    expect(rows[0]).toMatchObject({ status: 'ERROR', error: 'parse failed' });
  });

  it('returns no rows for an empty envelope', () => {
    expect(formatSignalTableRows(EMPTY_ENVELOPE)).toEqual([]);
  });
});

describe('formatSignalTableSummary', () => {
  it('derives the summary from the verdict + unit durations', () => {
    expect(formatSignalTableSummary(FIXTURE_ENVELOPE)).toEqual({
      passed: 1,
      failed: 1,
      totalErrors: 1,
      totalWarnings: 1,
      durationMs: 19,
    });
  });
});
