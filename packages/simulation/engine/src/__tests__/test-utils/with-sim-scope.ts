/**
 * @fileoverview Test helper — construct a RunScope with the simulation
 * subscope attached, then run a callback inside it.
 *
 * After Item 1 the scenario + recipe registries are per-RunScope. Tests
 * that touch them must build a scope first; this helper centralises the
 * boilerplate.
 */

import { makeTestScope } from '@opensip-tools/core/test-utils/with-scope.js';

import { simulationTool } from '../../tool.js';

import type { RunScope } from '@opensip-tools/core';

/** Build a fresh RunScope with `scope.simulation` populated. */
export function makeSimTestScope(): RunScope {
  const scope = makeTestScope();
  Object.assign(scope, simulationTool.contributeScope?.() ?? {});
  return scope;
}
