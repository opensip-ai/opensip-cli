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
 *   import { withScope, makeTestScope } from '@opensip-tools/core/test-utils/with-scope.js';
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

import { LanguageRegistry } from '../languages/registry.js';
import { RunScope, runWithScope, runWithScopeSync } from '../lib/run-scope.js';
import { ToolRegistry } from '../tools/registry.js';

import type { RunScopeOptions } from '../lib/run-scope.js';

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

/** Run `fn` inside `scope` and return its result. Thin alias for `runWithScope`. */
export function withScope<T>(scope: RunScope, fn: () => Promise<T>): Promise<T> {
  return runWithScope(scope, fn);
}

/** Synchronous variant of `withScope`. */
export function withScopeSync<T>(scope: RunScope, fn: () => T): T {
  return runWithScopeSync(scope, fn);
}
