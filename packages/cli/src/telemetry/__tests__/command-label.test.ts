import { afterEach, describe, expect, it } from 'vitest';

import {
  resetResolvedCommandLabel,
  resolvedCommandLabel,
  setResolvedCommandLabel,
} from '../command-label.js';

/**
 * The duration-metric command label (M12): bounded to the resolved command name
 * the pre-action hook stamps, defaulting to 'unknown' so cardinality can't blow
 * up on a typo/flag/path as argv[2].
 */
describe('command-label', () => {
  afterEach(() => {
    resetResolvedCommandLabel();
  });

  it("defaults to 'unknown' when no command has resolved", () => {
    resetResolvedCommandLabel();
    expect(resolvedCommandLabel()).toBe('unknown');
  });

  it('returns the resolved command name once the pre-action hook stamps it', () => {
    setResolvedCommandLabel('fit');
    expect(resolvedCommandLabel()).toBe('fit');
  });
});
