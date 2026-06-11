/**
 * @fileoverview Zod validation schema for opensip-tools.config.yml
 *
 * Defines the schema for signal producer configuration (fitness,
 * simulation) and file targeting. These settings live alongside the target
 * definitions in opensip-tools.config.yml.
 */

import {
  checkOverridesSchema,
  cliConfigSchema,
  dashboardConfigSchema,
  globalExcludesSchema,
  targetsRecordSchema,
} from '@opensip-tools/config';
import { z } from 'zod';

import {
  FITNESS_CONFIG_DEFAULTS,
  FitnessNamespaceSchema,
} from '../config/fitness-config-schema.js';

// =============================================================================
// Target Definition Schema — owned by @opensip-tools/config (2.10.1, ADR-0023)
// =============================================================================

// `targets` / `globalExcludes` / `checkOverrides` are the shared two-layer scope
// model; their schemas live in the config layer and the host registers them as
// document-level declarations. This whole-document loader still validates them
// because the fit hot path consumes targeting through `loadSignalersConfig`.

// =============================================================================
// Producer Schemas
// =============================================================================

/** Fitness config parser: one field definition, parser defaults for this loader. */
const FitnessSchema = FitnessNamespaceSchema.extend({
  failOnErrors: FitnessNamespaceSchema.shape.failOnErrors.default(
    FITNESS_CONFIG_DEFAULTS.failOnErrors,
  ),
  failOnWarnings: FitnessNamespaceSchema.shape.failOnWarnings.default(
    FITNESS_CONFIG_DEFAULTS.failOnWarnings,
  ),
  disabledChecks: FitnessNamespaceSchema.shape.disabledChecks.default([
    ...FITNESS_CONFIG_DEFAULTS.disabledChecks,
  ]),
});

/** Schema for simulation engine configuration. */
const SimulationSchema = z.object({
  // Default recipe for `sim` runs when no `--recipe` flag is given (ADR-0022).
  // Tool-scoped: distinct from `fitness.recipe` / `graph.recipe`. An unknown
  // name here tolerantly falls back to the built-in `default` recipe; an
  // explicit `--recipe` typo still hard-fails.
  recipe: z.string().min(1).max(128).optional(),
});

// =============================================================================
// CLI Defaults + Dashboard — now owned by @opensip-tools/config (2.10.1)
// =============================================================================

// The `cli:` and `dashboard:` blocks are tool-agnostic document-level config;
// their schemas moved to `@opensip-tools/config` in 2.10.1 (ADR-0023) and the
// host registers them as document-level declarations for the composed STRICT
// validation. This loader imports the schemas rather than re-defining them, so
// there is one definition of each.
const CliDefaultsSchema = cliConfigSchema;
const DashboardSchema = dashboardConfigSchema;

// =============================================================================
// Root Schema
// =============================================================================

/** Wrap a section schema so YAML `null` or missing keys are treated as `{}` (all defaults). */
function section<T extends z.ZodType>(schema: T) {
  // Zod 4 change: `.default(...)` no longer re-parses the supplied default through
  // the inner schema, so a literal `{}` default would skip every nested
  // `.default(...)` declaration on the section's fields. Instead, coerce
  // undefined / null inputs to `{}` *before* delegating to the section schema —
  // that way the inner schema parses `{}` and its per-field defaults apply.
  return z.preprocess((v) => v ?? {}, schema);
}

/** Root schema for opensip-tools.config.yml validation */
export const SignalersConfigSchema = z.object({
  // Top-level config schema version. The CLI checks this in pre-action-hook
  // (via readConfigSchemaVersion + checkSchemaCompat in core) BEFORE this
  // strict loader runs. Default 1 keeps existing configs (written before
  // the field existed) valid.
  schemaVersion: z.number().int().min(1).default(1),
  globalExcludes: globalExcludesSchema.default([]),
  targets: targetsRecordSchema.default({}),
  checkOverrides: checkOverridesSchema.optional(),
  fitness: section(FitnessSchema),
  simulation: section(SimulationSchema),
  cli: section(CliDefaultsSchema),
  dashboard: section(DashboardSchema),
});
