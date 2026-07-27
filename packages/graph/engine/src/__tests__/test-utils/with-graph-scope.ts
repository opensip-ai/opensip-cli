/**
 * @fileoverview Test helper — construct a RunScope with the graph
 * subscope attached, then run a callback inside it.
 *
 * After Item 1 the adapter + rule registries are per-RunScope. Tests
 * that touch them must build a scope first; this helper centralises
 * the boilerplate.
 */

import {
  applyToolContributeScope,
  LanguageRegistry,
  RunScope,
  runWithScopeSync,
  ToolRegistry,
} from '@opensip-cli/core';

import { graphTool } from '../../tool.js';

/** Fresh scope with empty registries — local equivalent of the retired
 *  `@opensip-cli/core/test-utils` helper (ADR-0040: that sugar moved to
 *  `@opensip-cli/test-support`, which this package's tests cannot use
 *  without coupling its test graph to the fitness engine). */
const makeTestScope = (abortSignal?: AbortSignal): RunScope =>
  new RunScope({
    languages: new LanguageRegistry(),
    tools: new ToolRegistry(),
    ...(abortSignal === undefined ? {} : { abortSignal }),
  });

/** Build a fresh RunScope with `scope.graph` populated. */
export function makeGraphTestScope(options?: { readonly abortSignal?: AbortSignal }): RunScope {
  const scope = makeTestScope(options?.abortSignal);
  applyToolContributeScope(scope, graphTool);
  return scope;
}

/** Run `fn` inside a fresh graph-extended scope; returns its result. */
export function withGraphScopeSync<T>(fn: () => T): T {
  return runWithScopeSync(makeGraphTestScope(), fn);
}
