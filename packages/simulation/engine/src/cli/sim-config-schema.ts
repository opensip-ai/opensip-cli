/**
 * sim-config-schema — the simulation tool's namespaced Zod config schema
 * (release 2.10.0, ADR-0023, Phase 4 Task 4.2).
 *
 * Describes the `simulation:` top-level block of `opensip-tools.config.yml`.
 * Today simulation owns a single knob — the tool-scoped `recipe` default
 * (ADR-0022) — so the schema is minimal; it grows as sim gains config.
 *
 * This is the schema simulation contributes to the host's composed
 * whole-document validation. The matching namespace KEY in the config file is
 * `simulation` (see `sim-config.ts`'s `readSimulationRecipe`), so a typo like
 * `simulation: { recpe: ... }` now fails strict at dispatch (ADR-0023).
 */

import { z } from 'zod';

import type { ToolConfigDeclaration } from '@opensip-tools/config';

/**
 * Zod object for the `simulation:` namespace. The `recipe` field is optional;
 * an absent block means sim falls back to the built-in `default` recipe.
 */
export const SimulationNamespaceSchema = z.object({
  /** Tool-scoped default recipe for `sim` runs (ADR-0022). */
  recipe: z.string().min(1).max(128).optional(),
});

/**
 * The simulation tool's contribution to the composed configuration document.
 * `namespace: 'simulation'` (matches the config file key); the composer makes
 * it strict (typo-rejecting) and optional. No defaults — the recipe falls back
 * through the shared `resolveToolRecipeName` precedence when absent.
 */
export const simulationConfigDeclaration: ToolConfigDeclaration = {
  namespace: 'simulation',
  schema: SimulationNamespaceSchema,
};
