import { describe, expect, it } from 'vitest';

import { isTestFilePath } from './test-file.js';

describe('isTestFilePath', () => {
  it('classifies __tests__ paths as test files', () => {
    expect(isTestFilePath('src/__tests__/foo.ts')).toBe(true);
  });

  it('classifies __fixtures__ paths as test scaffolding', () => {
    expect(isTestFilePath('src/__fixtures__/bar.ts')).toBe(true);
  });

  it('classifies .test.ts/.test.tsx suffixes', () => {
    expect(isTestFilePath('src/util.test.ts')).toBe(true);
    expect(isTestFilePath('src/util.test.tsx')).toBe(true);
  });

  it('classifies _test.ts suffixes', () => {
    expect(isTestFilePath('src/util_test.ts')).toBe(true);
  });

  it('returns false for production source paths', () => {
    expect(isTestFilePath('packages/core/src/index.ts')).toBe(false);
  });
});
