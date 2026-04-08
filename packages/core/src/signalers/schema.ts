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
    fitness: { failOnErrors: 1, failOnWarnings: 0, reconcile: true, ticketingAggregationThreshold: 0 },
    simulation: { reconcile: true },
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

export const SignalerScheduleSchema = z.object({
  name: z.string().min(1).max(128),
  recipe: z.string().min(1).max(128).optional(),
  scenario: z.string().min(1).max(128).optional(),
  interval: z.enum(['hourly', 'daily', 'weekdays', 'weekly']),
  time: z.string().regex(/^\d{2}:\d{2}$/).default('00:00'),
  day: z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']).optional(),
}).refine(s => s.interval !== 'weekly' || s.day != null, {
  message: 'Weekly schedules must specify a day',
})

export type SignalerScheduleConfig = z.infer<typeof SignalerScheduleSchema>

// =============================================================================
// Producer Schemas (copied from config/schema.ts — removed from there in Phase 2)
// =============================================================================

const FitnessTicketingSchema = z.object({
  aggregationThreshold: z.number().int().min(0).default(DEFAULTS.signals.fitness.ticketingAggregationThreshold),
})

/** Schema for fitness check configuration */
export const FitnessSchema = z.object({
  defaultTarget: z.string().min(1).max(255).optional(),
  maxParallel: z.number().int().min(1).optional(),
  timeout: z.number().int().min(1000).optional(),
  failOnErrors: z.number().int().min(0).default(DEFAULTS.signals.fitness.failOnErrors),
  failOnWarnings: z.number().int().min(0).default(DEFAULTS.signals.fitness.failOnWarnings),
  reconcile: z.boolean().default(DEFAULTS.signals.fitness.reconcile),
  disabledChecks: z.array(z.string().min(1).max(255)).optional().default([]),
  ticketing: z.preprocess((v) => v ?? {}, FitnessTicketingSchema).default({}),
  schedules: z.array(SignalerScheduleSchema).default([]),
})

/** Schema for simulation engine configuration */
export const SimulationSchema = z.object({
  reconcile: z.boolean().default(DEFAULTS.signals.simulation.reconcile),
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
// Root Schema
// =============================================================================

/** Wrap a section schema so YAML `null` is treated as `{}` (all defaults). */
function section<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => v ?? {}, schema).default({})
}

/** Root schema for opensip-tools.config.yml validation */
export const SignalersConfigSchema = z.object({
  globalExcludes: z.array(z.string()).default([]),
  targets: z.record(
    z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'target name must be kebab-case'),
    TargetDefinitionSchema,
  ).default({}),
  checkOverrides: z.record(z.string(), CheckTargetValueSchema).optional(),
  fitness: section(FitnessSchema),
  simulation: section(SimulationSchema),
})
