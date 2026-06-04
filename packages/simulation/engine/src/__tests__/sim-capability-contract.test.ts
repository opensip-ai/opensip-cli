/**
 * Capability contract for the `sim` tool.
 *
 * A Tier-2 guardrail (audit "Done Definition"): lock the promised surface so a
 * flag can't be added/removed without an explicit contract update, and prove
 * the scheduler applies CLI filters + recipe selectors BEFORE invoking any
 * scenario runner (the class of bug behind P0-1, where `--kind` filtered after
 * execution). Scoped to the non-cloud sim domain.
 */

import { enterScope } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearScenarioRegistry, currentScenarioRegistry } from '../framework/registry.js';
import { defineSimulationRecipe } from '../recipes/define-recipe.js';
import { SimulationRecipeService } from '../recipes/service.js';
import { simulationTool } from '../tool.js';

import { makeSimTestScope } from './test-utils/with-sim-scope.js';

import type { RunnableScenario } from '../framework/runnable-scenario.js';
import type { ToolCliContext } from '@opensip-tools/core';

// ---------------------------------------------------------------------------
// 1. Flag-surface lock
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for commander's `Command`, capturing the option flags the
 * sim tool registers. register() only ever touches
 * `program.command(...).description(...).option(...).action(...)`, so a chain
 * recorder is enough — no commander dependency, no action invocation.
 */
function recordRegisteredFlags(): string[] {
  const flags: string[] = [];
  const sub = {
    description: () => sub,
    option: (spec: string) => {
      const match = /--[a-z][a-z-]*/.exec(spec);
      if (match) flags.push(match[0]);
      return sub;
    },
    action: () => sub,
  };
  const program = { command: () => sub };
  simulationTool.register({ program } as unknown as ToolCliContext);
  return flags.sort();
}

describe('sim tool — flag-surface contract', () => {
  it('registers exactly the documented flag set (drift fails here)', () => {
    // Adding or removing a `sim` flag must be a deliberate change to this list,
    // so a new flag can't ship undocumented or an old one vanish silently.
    expect(recordRegisteredFlags()).toEqual(
      ['--cwd', '--debug', '--json', '--kind', '--open', '--quiet', '--recipe'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Scheduler-order: filters/selectors narrow BEFORE the runner
// ---------------------------------------------------------------------------

/** A scenario that records execution and rejects if ever run. */
function tripwire(id: string, kind: RunnableScenario['kind'], fired: { ran: boolean }): RunnableScenario {
  return {
    id,
    name: id,
    description: id,
    kind,
    tags: [],
    run: () => {
      fired.ran = true;
      return Promise.reject(new Error(`${id} must not run — it was narrowed out before execution`));
    },
  };
}

describe('sim scheduler — narrowing precedes execution', () => {
  beforeEach(() => {
    enterScope(makeSimTestScope());
  });
  afterEach(() => {
    clearScenarioRegistry();
  });

  it('a recipe selector excludes scenarios before they run', async () => {
    const fired = { ran: false };
    currentScenarioRegistry().register(tripwire('excluded-by-selector', 'load', fired));
    const recipe = defineSimulationRecipe({
      id: 'URCP_sel_exclude',
      name: 'sel-exclude',
      displayName: 'Selector exclude',
      description: 'x',
      scenarios: { type: 'all', exclude: ['excluded-by-selector'] },
      execution: { mode: 'sequential' },
    });

    const result = await new SimulationRecipeService().runRecipe(recipe);

    expect(fired.ran).toBe(false);
    expect(result.totalScenarios).toBe(0);
  });

  it('the --kind filter excludes other-kind scenarios before they run', async () => {
    const fired = { ran: false };
    currentScenarioRegistry().register(tripwire('excluded-by-kind', 'load', fired));
    const recipe = defineSimulationRecipe({
      id: 'URCP_kind_exclude',
      name: 'kind-exclude',
      displayName: 'Kind exclude',
      description: 'x',
      scenarios: { type: 'all' },
      execution: { mode: 'sequential' },
    });

    // kindFilter narrows to 'invariant'; the 'load' tripwire is dropped.
    const result = await new SimulationRecipeService().runRecipe(recipe, { kindFilter: 'invariant' });

    expect(fired.ran).toBe(false);
    expect(result.totalScenarios).toBe(0);
  });
});
