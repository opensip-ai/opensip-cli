import { readFileSync } from 'node:fs';

import * as fitness from '@opensip-cli/fitness';
import { describe, expect, it } from 'vitest';

import * as support from '../index.js';

describe('@opensip-cli/test-support public API', () => {
  it('owns the test-only fitness cache while the published fitness root does not', () => {
    expect(support).toHaveProperty('fitnessTestFileCache');
    expect(fitness).not.toHaveProperty('fileCache');
    expect(fitness).not.toHaveProperty('fitnessTestFileCache');
  });

  it('exposes concurrent-scope and CLI-json helpers on the barrel', () => {
    expect(typeof support.runTwoScopesConcurrently).toBe('function');
    expect(typeof support.parseCliJsonOutcomes).toBe('function');
    expect(support.parseCliJsonOutcomes('{"ok":true}')).toEqual([{ ok: true }]);
  });

  it('remains a private unpublished workspace package', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { readonly name?: string; readonly private?: boolean };
    expect(manifest).toMatchObject({ name: '@opensip-cli/test-support', private: true });
  });
});
