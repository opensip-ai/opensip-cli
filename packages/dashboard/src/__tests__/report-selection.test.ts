import { describe, expect, it } from 'vitest';

import {
  decodeReportViewSelection,
  encodeReportViewSelection,
  normalizeReportViewSelection,
} from '../report-selection.js';

describe('report selection', () => {
  it('round-trips the Change Impact view with and without a run identity', () => {
    expect(encodeReportViewSelection({ view: 'change-impact' })).toBe('#change-impact');
    expect(encodeReportViewSelection({ view: 'change-impact', runId: 'run_A-1' })).toBe(
      '#change-impact/run_A-1',
    );
    expect(decodeReportViewSelection('#change-impact')).toEqual({
      view: 'change-impact',
    });
    expect(decodeReportViewSelection('#change-impact/run_A-1')).toEqual({
      view: 'change-impact',
      runId: 'run_A-1',
    });
  });

  it.each([
    '',
    '#overview',
    '#change-impact/',
    '#change-impact/a/b',
    '#change-impact/%2Fetc',
    '#change-impact/%00bad',
    '#change-impact/%E0%A4%A',
    `#change-impact/${'a'.repeat(129)}`,
  ])('rejects malformed or unsupported fragment %s', (fragment) => {
    expect(decodeReportViewSelection(fragment)).toBeUndefined();
  });

  it('keeps the closed view but omits an invalid runtime run identity', () => {
    expect(
      normalizeReportViewSelection({
        view: 'change-impact',
        runId: 'run/../../escape#x',
      }),
    ).toEqual({ view: 'change-impact' });
    expect(
      encodeReportViewSelection({
        view: 'change-impact',
        runId: 'run/../../escape#x',
      }),
    ).toBe('#change-impact');
  });

  it('rejects unknown runtime view vocabulary', () => {
    expect(normalizeReportViewSelection({ view: 'panel-admin', runId: 'run-1' })).toBeUndefined();
  });
});
