/**
 * Capability contract for the `sim` tool.
 *
 * A Tier-2 guardrail (audit "Done Definition"): lock the promised surface so a
 * flag can't be added/removed without an explicit contract update, and prove
 * the scheduler applies recipe selectors BEFORE invoking any scenario runner
 * (so a narrowed-out scenario never runs). Scoped to the non-cloud sim domain.
 */

import { commonFlags } from '@opensip-cli/contracts';
import { runWithScope, runWithScopeSync } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearScenarioRegistry, currentScenarioRegistry } from '../framework/registry.js';
import { defineSimulationRecipe } from '../recipes/define-recipe.js';
import { SimulationRecipeService } from '../recipes/service.js';
import { simulationTool } from '../tool.js';

import { makeSimTestScope } from './test-utils/with-sim-scope.js';

import type { RunnableScenario } from '../framework/runnable-scenario.js';

// ---------------------------------------------------------------------------
// 1. Flag-surface lock
// ---------------------------------------------------------------------------

/**
 * Derive the `--long` flag set sim declares from its `CommandSpec` (release
 * 2.11.0 Phase 3): the ADR-0021 `commonFlags` keys mapped to their registry
 * `--long` strings, plus each tool-specific `OptionSpec.flag`. This locks the
 * exported command surface — adding/removing a flag must be a deliberate edit
 * to the expected list below, so nothing ships undocumented or vanishes silently.
 */
function recordRegisteredFlags(): string[] {
  const spec = simulationTool.commandSpecs?.[0];
  if (spec === undefined) throw new Error('simulationTool exposes no commandSpecs');
  const flags: string[] = [];
  for (const key of spec.commonFlags) {
    const match = /--[a-z][a-z-]*/.exec(commonFlags[key].flags);
    if (match) flags.push(match[0]);
  }
  for (const opt of spec.options ?? []) {
    const match = /--[a-z][a-z-]*/.exec(opt.flag);
    if (match) flags.push(match[0]);
  }
  return flags.sort();
}

describe('sim tool — flag-surface contract', () => {
  it('registers exactly the documented flag set (drift fails here)', () => {
    // Adding or removing a `sim` flag must be a deliberate change to this list,
    // so a new flag can't ship undocumented or an old one vanish silently.
    expect(recordRegisteredFlags()).toEqual(
      // ADR-0011 (Phase 4): sim gained cloud egress (--report-to / --api-key)
      // when it began emitting the signal envelope.
      // ADR-0021: sim gained -v/--verbose (cross-tool flag parity).
      [
        '--cwd',
        '--debug',
        '--filter',
        '--json',
        '--open',
        '--quiet',
        '--raw',
        '--verbose',
        '--recipe',
        '--report-to',
        '--api-key',
        '--show',
        '--top',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Scheduler-order: filters/selectors narrow BEFORE the runner
// ---------------------------------------------------------------------------

/** A scenario that records execution and rejects if ever run. */
function tripwire(
  id: string,
  kind: RunnableScenario['kind'],
  fired: { ran: boolean },
): RunnableScenario {
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
  let scope: ReturnType<typeof makeSimTestScope>;

  beforeEach(() => {
    scope = makeSimTestScope();
  });

  afterEach(() => {
    runWithScopeSync(scope, () => clearScenarioRegistry());
  });

  function inSimScope<T>(fn: () => Promise<T>): Promise<T> {
    return runWithScope(scope, fn);
  }

  it('a recipe selector excludes scenarios before they run', async () => {
    await inSimScope(async () => {
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
  });

  it('a kind recipe selector excludes other-kind scenarios before they run', async () => {
    await inSimScope(async () => {
      const fired = { ran: false };
      currentScenarioRegistry().register(tripwire('excluded-by-kind', 'load', fired));
      const recipe = defineSimulationRecipe({
        id: 'URCP_kind_exclude',
        name: 'kind-exclude',
        displayName: 'Kind exclude',
        description: 'x',
        // The recipe selects only chaos scenarios; the 'load' tripwire is dropped
        // before execution.
        scenarios: { type: 'kind', kinds: ['chaos'] },
        execution: { mode: 'sequential' },
      });

      const result = await new SimulationRecipeService().runRecipe(recipe);

      expect(fired.ran).toBe(false);
      expect(result.totalScenarios).toBe(0);
    });
  });
});
