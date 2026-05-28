/**
 * @fileoverview Test helper — construct a RunScope with the graph
 * subscope attached, then run a callback inside it.
 *
 * After Item 1 the adapter + rule registries are per-RunScope. Tests
 * that touch them must build a scope first; this helper centralises
 * the boilerplate.
 */

import { runWithScope, runWithScopeSync } from '@opensip-tools/core';
import { makeTestScope } from '@opensip-tools/core/test-utils/with-scope.js';

import { graphTool } from '../../tool.js';

import type { RunScope } from '@opensip-tools/core';

/** Build a fresh RunScope with `scope.graph` populated. */
export function makeGraphTestScope(): RunScope {
  const scope = makeTestScope();
  graphTool.extendScope?.(scope);
  return scope;
}

/** Run `fn` inside a fresh graph-extended scope; returns its result. */
export function withGraphScope<T>(fn: () => Promise<T>): Promise<T> {
  return runWithScope(makeGraphTestScope(), fn);
}

/** Sync variant of `withGraphScope`. */
export function withGraphScopeSync<T>(fn: () => T): T {
  return runWithScopeSync(makeGraphTestScope(), fn);
}
