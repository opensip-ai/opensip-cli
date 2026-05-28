/**
 * @fileoverview Test helper — construct a RunScope with the simulation
 * subscope attached, then run a callback inside it.
 *
 * After Item 1 the scenario + recipe registries are per-RunScope. Tests
 * that touch them must build a scope first; this helper centralises the
 * boilerplate.
 */

import { runWithScope, runWithScopeSync } from '@opensip-tools/core';
import { makeTestScope } from '@opensip-tools/core/test-utils/with-scope.js';

import { simulationTool } from '../../tool.js';

import type { RunScope } from '@opensip-tools/core';

/** Build a fresh RunScope with `scope.simulation` populated. */
export function makeSimTestScope(): RunScope {
  const scope = makeTestScope();
  simulationTool.extendScope?.(scope);
  return scope;
}

/** Run `fn` inside a fresh sim-extended scope; returns its result. */
export function withSimScope<T>(fn: () => Promise<T>): Promise<T> {
  return runWithScope(makeSimTestScope(), fn);
}

/** Sync variant of `withSimScope`. */
export function withSimScopeSync<T>(fn: () => T): T {
  return runWithScopeSync(makeSimTestScope(), fn);
}
