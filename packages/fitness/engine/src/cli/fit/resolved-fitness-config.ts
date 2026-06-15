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
 */

import { currentScope } from '@opensip-cli/core';

/** The fitness namespace's resolved knobs (mirror of `FitnessNamespaceSchema`). */
export interface ResolvedFitnessConfig {
  readonly defaultTarget?: string;
  readonly maxParallel?: number;
  readonly timeout?: number;
  readonly failOnErrors?: number;
  readonly failOnWarnings?: number;
  readonly disabledChecks?: readonly string[];
  readonly recipe?: string;
}

/** A plain-object guard that treats arrays and null as non-objects. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  return isPlainObject(block) ? block : undefined;
}
