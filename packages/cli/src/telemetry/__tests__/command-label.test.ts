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

  it('returns the bounded resolved command name rather than argv values', () => {
    setResolvedCommandLabel('audit');
    expect(resolvedCommandLabel()).toBe('audit');
  });

  it('never derives metric labels from file paths or refs in argv', () => {
    const previousArgv = process.argv;
    process.argv = [
      'node',
      'opensip',
      'audit',
      '--files',
      '/private/project/src/change.ts',
      '--since',
      'secret-review-ref',
    ];
    try {
      setResolvedCommandLabel('audit');
      expect(resolvedCommandLabel()).toBe('audit');
      expect(resolvedCommandLabel()).not.toMatch(/private|change\.ts|secret-review-ref/u);
    } finally {
      process.argv = previousArgv;
    }
  });
});
