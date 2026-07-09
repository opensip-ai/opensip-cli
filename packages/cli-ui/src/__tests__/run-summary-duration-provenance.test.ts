import { describe, it, expect } from 'vitest';

import { viewRunSummary } from '../run-summary.js';

/**
 * ADR-0144: final summary duration is the host-stamped value passed in
 * (or via RunTimingProvider when omitted). viewRunSummary must not invent
 * a second wall-clock sample — it only labels the provided durationMs.
 */
describe('RunSummary duration provenance', () => {
  it('labels the explicit host durationMs without re-sampling', () => {
    const node = viewRunSummary({
      passed: true,
      errors: 0,
      warnings: 0,
      durationMs: 19_850,
    });
    const text = JSON.stringify(node);
    expect(text).toContain('19.9s');
    expect(text).not.toContain('19.8s');
  });
});
