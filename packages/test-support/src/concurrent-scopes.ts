/**
 * @fileoverview Concurrent-scope test harness (ADR-0040 test scaffolding).
 *
 * Runs two test bodies under two distinct {@link RunScope}s concurrently, each
 * inside its own `runWithScope` so `currentScope()` resolves to the matching
 * scope for the dynamic extent of each fn. This is the executable form of the
 * parallel-tool-invocations rule: concurrent in-process work uses
 * `runWithScope` (which nests cleanly on the AsyncLocalStorage), NEVER a shared
 * `enterScope` (single-slot `enterWith`).
 */

import { runWithScope, type RunScope } from '@opensip-cli/core';

/**
 * Run `fnA` under `scopeA` and `fnB` under `scopeB` concurrently, each inside
 * its own `runWithScope` so each body's `currentScope()` resolves to its own
 * scope. Returns both results.
 *
 * Use this (never a shared `enterScope`) to assert two overlapping runs do not
 * share mutable per-scope state.
 */
export function runTwoScopesConcurrently<A, B>(
  scopeA: RunScope,
  fnA: () => Promise<A>,
  scopeB: RunScope,
  fnB: () => Promise<B>,
): Promise<[A, B]> {
  return Promise.all([runWithScope(scopeA, fnA), runWithScope(scopeB, fnB)]);
}
