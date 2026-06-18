/**
 * @fileoverview Test helper — construct a RunScope with the simulation
 * subscope attached, then run a callback inside it.
 *
 * After Item 1 the scenario + recipe registries are per-RunScope. Tests
 * that touch them must build a scope first; this helper centralises the
 * boilerplate.
 */

import {
  LanguageRegistry,
  RunScope,
  ToolRegistry,
  applyToolContributeScope,
} from '@opensip-cli/core';

import { simulationTool } from '../../tool.js';

/** Fresh scope with empty registries — local equivalent of the retired
 *  `@opensip-cli/core/test-utils` helper (ADR-0040: that sugar moved to
 *  `@opensip-cli/test-support`, which this package's tests cannot use
 *  without coupling its test graph to the fitness engine). */
const makeTestScope = (): RunScope =>
  new RunScope({ languages: new LanguageRegistry(), tools: new ToolRegistry() });

/** Build a fresh RunScope with `scope.simulation` populated. */
export function makeSimTestScope(): RunScope {
  const scope = makeTestScope();
  applyToolContributeScope(scope, simulationTool);
  return scope;
}
