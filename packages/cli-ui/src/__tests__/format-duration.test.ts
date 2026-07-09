import { formatDuration } from '@opensip-cli/format';
import { describe, it, expect } from 'vitest';

/**
 * Smoke: cli-ui live surfaces import the shared formatter (ADR-0144).
 * Canonical goldens live in @opensip-cli/format.
 */
describe('cli-ui formatDuration import', () => {
  it('resolves the shared formatter used by live tables and RunSummary', () => {
    expect(formatDuration(19_850)).toBe('19.9s');
    expect(formatDuration(12_340)).toBe('12.3s');
  });
});
