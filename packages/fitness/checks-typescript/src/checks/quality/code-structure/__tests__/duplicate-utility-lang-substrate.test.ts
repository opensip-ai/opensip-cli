/**
 * @fileoverview Regression tests for ADR-0010 lang-* substrate exclusion (P3.1).
 */

import { describe, expect, it } from 'vitest';

import { isLangSubstratePath } from '../duplicate-utility-functions-helpers.js';

describe('duplicate-utility-functions — lang substrate path exclusion', () => {
  it('matches every lang-* pack under packages/languages/', () => {
    expect(isLangSubstratePath('packages/languages/lang-typescript/src/parse.ts')).toBe(true);
    expect(isLangSubstratePath('packages/languages/lang-go/src/query.ts')).toBe(true);
    expect(isLangSubstratePath(String.raw`packages\languages\lang-rust\src\query.ts`)).toBe(true);
  });

  it('does not match product runtime outside lang-*', () => {
    expect(isLangSubstratePath('packages/core/src/lib/registry.ts')).toBe(false);
    expect(isLangSubstratePath('packages/cli-ui/src/format-duration.ts')).toBe(false);
  });
});