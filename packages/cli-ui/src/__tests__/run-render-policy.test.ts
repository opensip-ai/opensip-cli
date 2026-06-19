import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RUN_FOOTER_HINTS,
  shouldRenderRunFooterHints,
  shouldRenderRunUnitTable,
} from '../run-render-policy.js';

describe('run render policy', () => {
  it('keeps default fresh runs compact', () => {
    expect(shouldRenderRunUnitTable({})).toBe(false);
    expect(shouldRenderRunFooterHints({})).toBe(true);
  });

  it('shows detailed tables for verbose, detail, and replay surfaces', () => {
    for (const input of [{ verbose: true }, { detail: true }, { replay: true }]) {
      expect(shouldRenderRunUnitTable(input)).toBe(true);
      expect(shouldRenderRunFooterHints(input)).toBe(false);
    }
  });

  it('owns the canonical compact-run footer hints', () => {
    expect(DEFAULT_RUN_FOOTER_HINTS.map((hint) => hint.text)).toEqual([
      'Use --verbose for detailed results',
      'opensip report for HTML report',
    ]);
  });
});
