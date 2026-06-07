/**
 * @fileoverview Zod validation schema for opensip-tools.config.yml
 *
 * Defines the schema for signal producer configuration (fitness,
 * simulation) and file targeting. These settings live alongside the target
 * definitions in opensip-tools.config.yml.
 */

import { cliConfigSchema, dashboardConfigSchema } from '@opensip-tools/config'
import { z } from 'zod'

// Inline defaults
const DEFAULTS = {
  signals: {
    fitness: { failOnErrors: 1, failOnWarnings: 0 },
  },
} as const;

// =============================================================================
// Target Definition Schema
// =============================================================================

const TargetDefinitionSchema = z.object({
  description: z.string().min(1, 'description is required'),
  include: z.array(z.string()).min(1, 'at least one include pattern is required'),
  exclude: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  concerns: z.array(z.string()).optional(),
})

// =============================================================================
// Producer Schemas (copied from config/schema.ts — removed from there in Phase 2)
// =============================================================================

/** Schema for fitness check configuration */
const FitnessSchema = z.object({
  defaultTarget: z.string().min(1).max(255).optional(),
  maxParallel: z.number().int().min(1).optional(),
  timeout: z.number().int().min(1000).optional(),
  failOnErrors: z.number().int().min(0).default(DEFAULTS.signals.fitness.failOnErrors),
  failOnWarnings: z.number().int().min(0).default(DEFAULTS.signals.fitness.failOnWarnings),
  disabledChecks: z.array(z.string().min(1).max(255)).optional().default([]),
  // Default recipe for `fit` runs when no `--recipe` flag is given (ADR-0022).
  // Tool-scoped: distinct from `graph.recipe` / `simulation.recipe`. An unknown
  // name here tolerantly falls back to the built-in `default` recipe; an
  // explicit `--recipe` typo still hard-fails.
  recipe: z.string().min(1).max(128).optional(),
})

/** Schema for simulation engine configuration. */
const SimulationSchema = z.object({
  // Default recipe for `sim` runs when no `--recipe` flag is given (ADR-0022).
  // Tool-scoped: distinct from `fitness.recipe` / `graph.recipe`. An unknown
  // name here tolerantly falls back to the built-in `default` recipe; an
  // explicit `--recipe` typo still hard-fails.
  recipe: z.string().min(1).max(128).optional(),
})

// =============================================================================
// Check Overrides
// =============================================================================

const CheckTargetValueSchema = z.union([
  z.string(),
  z.array(z.string()).min(1),
])

// =============================================================================
// CLI Defaults + Dashboard — now owned by @opensip-tools/config (2.10.1)
// =============================================================================

// The `cli:` and `dashboard:` blocks are tool-agnostic document-level config;
// their schemas moved to `@opensip-tools/config` in 2.10.1 (ADR-0023) and the
// host registers them as document-level declarations for the composed STRICT
// validation. This loader still reads them off the whole document (so
// `signalersConfig.cli.recipe` / `.dashboard.editor` keep resolving) until
// fitness is repointed to the composed scope config (Phase 4) — it imports the
// schemas rather than re-defining them, so there is one definition of each.
const CliDefaultsSchema = cliConfigSchema
const DashboardSchema = dashboardConfigSchema

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
  return z.preprocess((v) => v ?? {}, schema)
}

/** Root schema for opensip-tools.config.yml validation */
export const SignalersConfigSchema = z.object({
  // Top-level config schema version. The CLI checks this in pre-action-hook
  // (via readConfigSchemaVersion + checkSchemaCompat in core) BEFORE this
  // strict loader runs. Default 1 keeps existing configs (written before
  // the field existed) valid.
  schemaVersion: z.number().int().min(1).default(1),
  globalExcludes: z.array(z.string()).default([]),
  targets: z.record(
    z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'target name must be kebab-case'),
    TargetDefinitionSchema,
  ).default({}),
  checkOverrides: z.record(z.string(), CheckTargetValueSchema).optional(),
  fitness:    section(FitnessSchema),
  simulation: section(SimulationSchema),
  cli:        section(CliDefaultsSchema),
  dashboard:  section(DashboardSchema),
})
