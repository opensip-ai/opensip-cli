import { runWithScope } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { makeGraphTestScope } from '../../__tests__/test-utils/with-graph-scope.js';
import { listGraphRules } from '../graph-list.js';

describe('listGraphRules', () => {
  it('returns registered graph rules through the shared list-checks contract', async () => {
    const result = await runWithScope(makeGraphTestScope(), listGraphRules);

    expect(result.type).toBe('list-checks');
    expect(result.title).toBe('Available Graph Rules');
    expect(result.totalCount).toBe(result.checks.length);
    expect(result.checks.length).toBeGreaterThan(0);

    const rule = result.checks.find((check) => check.slug === 'graph:wide-function');
    expect(rule).toEqual({
      slug: 'graph:wide-function',
      description: 'warning-level graph rule',
      tags: ['warning'],
    });
  });
});
