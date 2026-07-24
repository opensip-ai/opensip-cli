import { describe, expect, it } from 'vitest';

import { DEFAULT_PREWARM_PATTERNS } from '../../framework/file-cache.js';
import { computePrewarmPatterns } from '../service-prewarm.js';

import type { Check } from '../../framework/registry.js';

function checkWithFileTypes(fileTypes?: readonly string[]): Check {
  return { config: { fileTypes } } as unknown as Check;
}

describe('computePrewarmPatterns', () => {
  it('maps declared fileTypes to glob patterns when every check declares them', () => {
    expect(
      computePrewarmPatterns([checkWithFileTypes(['py']), checkWithFileTypes(['go', 'py'])]),
    ).toEqual(['**/*.go', '**/*.py']);
  });

  it('unions defaults WITH declared fileTypes when a universal check is present', () => {
    // The old early-return dropped declared extensions entirely: one
    // universal check meant .map/.py files were never prewarmed and the
    // checks declaring them saw a scheduling-dependent universe.
    const patterns = computePrewarmPatterns([
      checkWithFileTypes(),
      checkWithFileTypes(['map', 'py']),
    ]);
    for (const pattern of DEFAULT_PREWARM_PATTERNS) {
      expect(patterns).toContain(pattern);
    }
    expect(patterns).toContain('**/*.map');
    expect(patterns).toContain('**/*.py');
  });

  it('does not duplicate a declared extension already in the defaults', () => {
    const patterns = computePrewarmPatterns([checkWithFileTypes(), checkWithFileTypes(['ts'])]);
    expect(patterns.filter((pattern) => pattern === '**/*.ts')).toHaveLength(1);
  });

  it('returns the defaults alone for a purely universal set', () => {
    expect(computePrewarmPatterns([checkWithFileTypes()])).toEqual([...DEFAULT_PREWARM_PATTERNS]);
  });
});
