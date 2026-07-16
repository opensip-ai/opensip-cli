import { currentScope } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { runTwoScopesConcurrently } from '../concurrent-scopes.js';
import { makeTestScope } from '../with-scope.js';

describe('runTwoScopesConcurrently', () => {
  it('runs two bodies under distinct scopes without cross-talk', async () => {
    const scopeA = makeTestScope();
    const scopeB = makeTestScope();
    try {
      const [fromA, fromB] = await runTwoScopesConcurrently(
        scopeA,
        async () => {
          await Promise.resolve();
          expect(currentScope()).toBe(scopeA);
          return 'a';
        },
        scopeB,
        async () => {
          await Promise.resolve();
          expect(currentScope()).toBe(scopeB);
          return 'b';
        },
      );
      expect(fromA).toBe('a');
      expect(fromB).toBe('b');
    } finally {
      scopeA.dispose();
      scopeB.dispose();
    }
  });
});
