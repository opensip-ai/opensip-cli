/**
 * fitness-config-schema — the fitness tool's namespaced Zod config schema
 * (release 2.10.0, ADR-0023, Phase 4 Task 4.2).
 *
 * Describes the `fitness:` top-level block of `opensip-tools.config.yml` —
 * the knobs fitness owns: gate thresholds (`failOnErrors`/`failOnWarnings`),
 * the `disabledChecks` list, the tool-scoped `recipe` default, and the
 * scheduling/targeting knobs (`defaultTarget`/`maxParallel`/`timeout`).
 *
 * This is the schema fitness contributes to the host's composed
 * whole-document validation. It deliberately covers ONLY the `fitness:`
 * namespace — shared targeting (`targets`/`globalExcludes`/`checkOverrides`)
 * and the `cli:` block stay with their existing loaders (the strict
 * `SignalersConfigSchema`); they migrate to namespaced declarations in
 * 2.10.1. So `loadSignalersConfig` keeps reading the document for targeting +
 * fitness-block values; the composed dispatch-level gate adds the strict
 * cross-tool typo check over the three TOOL namespaces.
 *
 * Defaults live on the {@link ToolConfigDeclaration} (`failOnErrors: 1`,
 * `failOnWarnings: 0`, `disabledChecks: []`) — the lowest-precedence source
 * the resolver merges — rather than as Zod `.default(...)` so the composed
 * namespace schema validates a user document without injecting values.
 */

import { z } from 'zod';

import type { ToolConfigDeclaration } from '@opensip-tools/config';

/**
 * Zod object for the `fitness:` namespace. Every field optional so a config
 * that omits the block (or any individual knob) is valid; the declaration's
 * `defaults` supply the effective values.
 */
export const FitnessNamespaceSchema = z.object({
  /** Named target a bare `fit` run scopes to when no `--target` is given. */
  defaultTarget: z.string().min(1).max(255).optional(),
  /** Max checks evaluated in parallel. */
  maxParallel: z.number().int().min(1).optional(),
  /** Per-check timeout in milliseconds. */
  timeout: z.number().int().min(1000).optional(),
  /** Gate: fail when total errors >= this (0 = never fail on errors). */
  failOnErrors: z.number().int().min(0).optional(),
  /** Gate: fail when total warnings >= this (0 = never fail on warnings). */
  failOnWarnings: z.number().int().min(0).optional(),
  /** Slugs disabled project-wide. */
  disabledChecks: z.array(z.string().min(1).max(255)).optional(),
  /** Tool-scoped default recipe for `fit` runs (ADR-0022). */
  recipe: z.string().min(1).max(128).optional(),
});

/**
 * The fitness tool's contribution to the composed configuration document.
 * `namespace: 'fitness'`; the composer makes it strict (typo-rejecting) and
 * optional. Defaults mirror the historical `SignalersConfigSchema` fitness
 * defaults so the resolved config matches the established behaviour.
 */
export const fitnessConfigDeclaration: ToolConfigDeclaration = {
  namespace: 'fitness',
  schema: FitnessNamespaceSchema,
  defaults: {
    failOnErrors: 1,
    failOnWarnings: 0,
    disabledChecks: [],
  },
  env: [
    { envVar: 'OPENSIP_FIT_FAIL_ON_ERRORS', key: 'failOnErrors', type: 'number' },
    { envVar: 'OPENSIP_FIT_FAIL_ON_WARNINGS', key: 'failOnWarnings', type: 'number' },
  ],
};
