/**
 * enterScope always-on re-entrancy guard (parallel-tool-invocations Phase 2/4).
 *
 * Phase 2 made `enterScope` throw `SYSTEM.SCOPE.REENTRANT` when a *different*
 * scope is already current (`run-scope.ts`). The full three-branch truth table
 * (different → throws with `.code === 'SYSTEM.SCOPE.REENTRANT'`; same → no-op;
 * none-current → binds) and the nested-`runWithScope`-never-trips case are
 * already pinned in `run-scope.test.ts` (migrated there from the old
 * silent-replacement assertion). This focused file does NOT re-assert that
 * truth table; it pins the two guard contracts that file leaves implicit:
 *
 *   1. The thrown error is actionable — its message names `runWithScope` as the
 *      sanctioned concurrent/nested binding, so a misuser is told the fix.
 *   2. The guard is fail-safe — it throws BEFORE mutating the ALS slot, so the
 *      current scope is unchanged when a different-scope `enterScope` is rejected
 *      (asserted from inside a nested `runWithScope` frame so the would-be
 *      `enterWith` cannot leak into the test runner).
 *
 * Per the phase note: the none-current branch is exercised OUTSIDE any
 * `runWithScope` wrapper (Vitest gives each test a clean ALS store), never by
 * wrapping in `runWithScope(new RunScope(), …)` — that wrapper is reserved for
 * the nested-scope case, which never trips the guard.
 */

import { describe, expect, it } from 'vitest';

import { SystemError } from '../errors.js';
import { RunScope, runWithScope, currentScope, enterScope } from '../run-scope.js';

describe('enterScope re-entrancy guard — actionable + fail-safe', () => {
  it('the thrown error names runWithScope as the concurrent/nested binding', async () => {
    const outer = new RunScope();
    const other = new RunScope();
    await runWithScope(outer, () => {
      let captured: SystemError | undefined;
      try {
        enterScope(other);
        expect.unreachable('enterScope must throw for a different current scope');
      } catch (error) {
        captured = error as SystemError;
      }
      expect(captured).toBeInstanceOf(SystemError);
      expect(captured?.code).toBe('SYSTEM.SCOPE.REENTRANT');
      // The message must point the misuser at the fix.
      expect(captured?.message).toContain('runWithScope');
      return Promise.resolve();
    });
    outer.dispose();
    other.dispose();
  });

  it('guard throws BEFORE mutating the slot — current scope is unchanged', async () => {
    const outer = new RunScope();
    const other = new RunScope();
    await runWithScope(outer, async () => {
      expect(currentScope()).toBe(outer);
      expect(() => enterScope(other)).toThrow(SystemError);
      // The slot was never mutated: `other` did not become current.
      expect(currentScope()).toBe(outer);
      // …and it stays `outer` across an await boundary (the enterWith never ran).
      await Promise.resolve();
      expect(currentScope()).toBe(outer);
    });
    outer.dispose();
    other.dispose();
  });

  it('none-current entry (outside any runWithScope) binds and does not throw', () => {
    // Vitest isolates the ALS store per test, so currentScope() is undefined on
    // entry — the production single-command path (pre-action hook). Entering
    // when none is current is allowed and binds the scope; the enterWith here
    // does not leak into sibling tests.
    const scope = new RunScope();
    expect(currentScope()).toBeUndefined();
    expect(() => enterScope(scope)).not.toThrow();
    expect(currentScope()).toBe(scope);
    scope.dispose();
  });
});
