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

import {
  LanguageRegistry,
  RunScope,
  ToolRegistry,
  isContributionWithDisposer,
  runWithScope,
  runWithScopeSync,
} from '@opensip-cli/core';
import { fitnessTool } from '@opensip-cli/fitness';

import type { RunScopeOptions } from '@opensip-cli/core';

/**
 * Construct a fresh `RunScope` with empty `LanguageRegistry` /
 * `ToolRegistry` instances. Override any field via `opts`.
 */
export function makeTestScope(opts: RunScopeOptions = {}): RunScope {
  return new RunScope({
    languages: opts.languages ?? new LanguageRegistry(),
    tools: opts.tools ?? new ToolRegistry(),
    ...opts,
  });
}

/**
 * Construct a test `RunScope` carrying fitness's contributed subscope (incl. its
 * per-run `fileCache`), mirroring the production CLI install loop. Use this for
 * tests that run a fitness `Check.run(...)`: the check resolves its per-run cache
 * from `currentScope()?.fitness?.fileCache` (no module-singleton fallback —
 * parallel-tool-invocations Phase 1), so a file-reading check needs a scope that
 * carries it. Override base fields via `opts` (e.g. a populated `languages`).
 */
export function makeFitnessTestScope(opts: RunScopeOptions = {}): RunScope {
  const scope = makeTestScope(opts);
  const contribution = fitnessTool.contributeScope?.() ?? {};
  if (isContributionWithDisposer(contribution)) {
    Object.assign(scope, contribution.contribution);
    if (contribution.onDispose) scope.onDispose(contribution.onDispose);
  } else {
    Object.assign(scope, contribution);
  }
  return scope;
}

/** Run `fn` inside `scope` and return its result. Thin alias for `runWithScope`. */
export function withScope<T>(scope: RunScope, fn: () => Promise<T>): Promise<T> {
  return runWithScope(scope, fn);
}

/** Synchronous variant of `withScope`. */
export function withScopeSync<T>(scope: RunScope, fn: () => T): T {
  return runWithScopeSync(scope, fn);
}
