/**
 * @fileoverview Regression tests for two `null-safety` FP fixes.
 *
 * 1. Cross-line guard: a property access guarded by an enclosing `if` / `&&`
 *    on a PREVIOUS line (e.g. `if (candidates.length === 1 && candidates[0])
 *    { … candidates[0].bodyHash … }`) was flagged because the safety scan was
 *    line-local. The fix walks enclosing conditions.
 * 2. Immutable combinators: `.merge(...)` chained on a factory result
 *    (e.g. OTel `detectResources(...).merge(...)`) returns a non-null value
 *    and is now a known-safe fluent method.
 *
 * Genuine unguarded access on a call/element result must still fire.
 */

import { describe, expect, it } from 'vitest';

import { analyzeNullSafety } from '../null-safety.js';

function analyze(src: string): readonly { line: number }[] {
  return analyzeNullSafety(src, 'src/svc/sample.ts');
}

describe('null-safety — FP regression suite', () => {
  it('does NOT flag element access guarded by an enclosing if on a previous line', () => {
    const src = `
      function pick(candidates: { bodyHash: string }[]) {
        if (candidates.length === 1 && candidates[0]) {
          return [candidates[0].bodyHash];
        }
        return [];
      }
    `;
    expect(analyze(src)).toHaveLength(0);
  });

  it('does NOT flag `.merge(...)` chained on a factory call result', () => {
    const src = `
      function build() {
        const resource = detectResources({ detectors: [envDetector] }).merge(
          resourceFromAttributes({ name: 'svc' }),
        );
        return resource;
      }
    `;
    expect(analyze(src)).toHaveLength(0);
  });

  it('STILL flags an unguarded property access on an element-access result', () => {
    const src = `
      function firstHash(rows: { bodyHash: string }[]) {
        return rows[0].bodyHash;
      }
    `;
    expect(analyze(src).length).toBeGreaterThan(0);
  });
});
