/**
 * @fileoverview Zod validation schema for opensip-tools.config.yml
 *
 * Defines the schema for signal producer configuration (fitness, simulation,
 * assess) and file targeting. These settings live alongside the target
 * definitions in opensip-tools.config.yml.
 */

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
// Signaler Schedule Schema
// =============================================================================

const SignalerScheduleSchema = z.object({
  name: z.string().min(1).max(128),
  recipe: z.string().min(1).max(128).optional(),
  scenario: z.string().min(1).max(128).optional(),
  interval: z.enum(['hourly', 'daily', 'weekdays', 'weekly']),
  time: z.string().regex(/^\d{2}:\d{2}$/).default('00:00'),
  day: z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']).optional(),
}).refine(s => s.interval !== 'weekly' || s.day != null, {
  message: 'Weekly schedules must specify a day',
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
  schedules: z.array(SignalerScheduleSchema).default([]),
})

/** Schema for simulation engine configuration */
const SimulationSchema = z.object({
  schedules: z.array(SignalerScheduleSchema).default([]),
})

// =============================================================================
// Check Overrides
// =============================================================================

const CheckTargetValueSchema = z.union([
  z.string(),
  z.array(z.string()).min(1),
])

// =============================================================================
// CLI Defaults
// =============================================================================

/**
 * Defaults applied to every `opensip-tools` CLI invocation in the project.
 * Equivalent to flags on the command line (`--recipe`, `--exclude`, …) but
 * declared once in the project config so every contributor and CI run agrees.
 *
 * Lives alongside targets so a project can ship a single config file.
 */
const CliDefaultsSchema = z.object({
  recipe:    z.string().min(1).max(128).optional(),
  exclude:   z.array(z.string()).optional(),
  verbose:   z.boolean().optional(),
  json:      z.boolean().optional(),
  reportTo:  z.string().url().optional(),
  apiKey:    z.string().min(1).optional(),
  fileTypes: z.array(z.string()).optional(),
  ignore:    z.array(z.string()).optional(),
})

// =============================================================================
// Dashboard
// =============================================================================

/**
 * Dashboard-specific settings. Currently just the editor protocol used
 * by the Code Paths panel to build vscode://, cursor://, etc. deep
 * links. Lifted out of the dashboard's hand-rolled YAML walker so the
 * value flows through the same schema as the rest of the config.
 */
const DashboardSchema = z.object({
  editor: z.string().min(1).max(64).optional(),
})

// =============================================================================
// Root Schema
// =============================================================================

/** Wrap a section schema so YAML `null` is treated as `{}` (all defaults). */
function section<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => v ?? {}, schema).default({})
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
