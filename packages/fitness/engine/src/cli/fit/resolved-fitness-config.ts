/**
 * resolved-fitness-config — read the fitness tool's RESOLVED config block off
 * the per-run scope (ADR-0023, Phase 4).
 *
 * The CLI's pre-action hook composes every tool's namespaced
 * `ToolConfigDeclaration` into ONE strict whole-document schema, validates the
 * document, and resolves precedence (flag > env > file > defaults). The
 * precedence-resolved result rides on `currentScope().toolConfig` — keyed by
 * namespace (`fitness`/`graph`/`simulation`).
 *
 * Before this module, fitness re-read `opensip-cli.config.yml` through
 * `loadSignalersConfig` and projected `signalersConfig.fitness.*`. That path
 * NEVER saw the declared env bindings (`OPENSIP_FIT_FAIL_ON_ERRORS` /
 * `OPENSIP_FIT_FAIL_ON_WARNINGS`) — they resolved into `scope.toolConfig` but
 * were no-ops at the gate. Reading the resolved block here makes env (and any
 * future flag) precedence the runtime source of truth for the fitness knobs.
 *
 * The shape mirrors `FitnessNamespaceSchema` (`config/fitness-config-schema.ts`)
 * — kept as a plain readonly interface here rather than importing the Zod
 * inferred type, because the kernel hands fitness a Zod-free
 * `Record<string, unknown>` on `scope.toolConfig` (the kernel carries no
 * config-layer dependency). The values were already strict-validated by the
 * composer before they landed on the scope, so a structural narrowing is sound.
 * Host-reserved gate keys added by config's tool-namespace decoration are
 * included here because they are part of the resolved runtime shape.
 */

import { currentScope, isPlainRecord } from '@opensip-cli/core';

import type { FitnessRecipe } from '../../recipes/types.js';

/** The fitness namespace's resolved knobs (mirror of `FitnessNamespaceSchema`). */
export interface ResolvedFitnessConfig {
  readonly defaultTarget?: string;
  readonly maxParallel?: number;
  readonly timeout?: number;
  readonly failOnErrors?: number;
  readonly failOnWarnings?: number;
  readonly failOnDegraded?: boolean;
  readonly disabledChecks?: readonly string[];
  readonly recipe?: string;
}

/**
 * Read the resolved `fitness:` block off the current scope's `toolConfig`.
 *
 * Returns `undefined` when there is no scope (a unit test that did not wrap in
 * `runWithScope`) or no `toolConfig` (a config-less project, or a
 * project-agnostic command). Callers fall back to their established
 * file-sourced defaults in that case, so the gate stays defined even off the
 * CLI dispatch path.
 *
 * The block is already strict-validated + precedence-resolved by the host
 * (flag > env > file > defaults); this is a pure read, no validation.
 */
export function resolvedFitnessConfig(): ResolvedFitnessConfig | undefined {
  const block = currentScope()?.toolConfig?.fitness;
  return isPlainRecord(block) ? block : undefined;
}

/**
 * The project-level scheduling knobs a `fitness:` config block may impose on
 * the recipe that is about to run.
 */
export interface FitnessExecutionOverrides {
  /** Per-check timeout in ms (`fitness.timeout`). */
  readonly timeout?: number;
  /** Cap on parallel checks (`fitness.maxParallel`). */
  readonly maxParallel?: number;
}

/**
 * Apply the project's `fitness.timeout` / `fitness.maxParallel` over the
 * selected recipe's own execution options.
 *
 * Both knobs are validated by {@link FitnessNamespaceSchema} and documented in
 * `docs/public/70-reference/03-configuration.md`, but nothing read them: a
 * recipe's hard-coded `timeout` (30s on the built-in `default`) won every run,
 * so a user who granted a slow check 120s still saw it recorded as a
 * `timeout`-status unit fault. Config WINS when present — it is the narrower,
 * project-specific statement of intent; when absent the recipe's own value (and
 * below that the engine defaults) stands, so recipes that deliberately pick a
 * long/short budget are unaffected.
 *
 * Returns the recipe unchanged when neither knob is set, so the common path
 * keeps the exact frozen recipe object the registry handed out.
 */
export function applyFitnessExecutionOverrides(
  recipe: FitnessRecipe,
  overrides: FitnessExecutionOverrides | undefined,
): FitnessRecipe {
  const timeout = overrides?.timeout;
  const maxParallel = overrides?.maxParallel;
  if (timeout === undefined && maxParallel === undefined) return recipe;
  return {
    ...recipe,
    execution: {
      ...recipe.execution,
      ...(timeout === undefined ? {} : { timeout }),
      ...(maxParallel === undefined ? {} : { maxParallel }),
    },
  };
}
