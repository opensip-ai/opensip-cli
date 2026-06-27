/**
 * @fileoverview Test-only helpers for running test bodies inside a
 * `RunScope` with explicit registry/cache wiring.
 *
 * Production code reads registries via `currentScope()`. After the T1
 * deferred-task wave deleted `defaultLanguageRegistry` and
 * `defaultToolRegistry`, tests that touched registry-aware code paths
 * (canonicalize, forFile, plugin loader, parse-cache) had to construct
 * a scope per test. These helpers centralise that boilerplate so the
 * churn per migrated test file is one import + one wrap.
 *
 * Usage:
 *
 *   import { withScope, makeTestScope } from '@opensip-cli/test-support';
 *
 *   it('does the thing', async () => {
 *     const scope = makeTestScope();
 *     scope.languages.register(myAdapter);
 *     await withScope(scope, async () => {
 *       expect(myFunctionThatReadsScope()).toBe('expected');
 *     });
 *   });
 *
 * `withScope` is a thin alias for `runWithScope` that returns the
 * function's return value; `makeTestScope` is a default-arg constructor
 * for a scope with fresh empty registries.
 */

import { applyToolContributeScope, type RunScope, type RunScopeOptions } from '@opensip-cli/core';
import { fitnessTool } from '@opensip-cli/fitness';
import { makeTestScope as createBaseTestScope } from '@opensip-cli/tool-test-kit';

export { makeTestScope, withScope, withScopeSync } from '@opensip-cli/tool-test-kit';

/**
 * Construct a test `RunScope` carrying fitness's contributed subscope (incl. its
 * per-run `fileCache`), mirroring the production CLI install loop. Use this for
 * tests that run a fitness `Check.run(...)`: the check resolves its per-run cache
 * from `currentScope()?.fitness?.fileCache` (no module-singleton fallback —
 * parallel-tool-invocations Phase 1), so a file-reading check needs a scope that
 * carries it. Override base fields via `opts` (e.g. a populated `languages`).
 */
export function makeFitnessTestScope(opts: RunScopeOptions = {}): RunScope {
  const scope = createBaseTestScope(opts);
  applyToolContributeScope(scope, fitnessTool);
  return scope;
}
