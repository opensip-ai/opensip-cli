/**
 * @fileoverview Signalers config barrel export
 *
 * Public API for opensip-tools.config.yml:
 * - loadSignalersConfig() — Load and validate signalers config
 * - SignalersConfigSchema — Zod schema
 * - SignalersConfig — TypeScript type
 */

// Schema
export { SignalersConfigSchema, FitnessSchema, SimulationSchema, SignalerScheduleSchema, CliDefaultsSchema } from './schema.js'
export type { SignalerScheduleConfig } from './schema.js'

// Types
export type { SignalersConfig, SignalersFitnessConfig, SignalersSimulationConfig, SignalersCliDefaultsConfig } from './types.js'

// Loader
export { loadSignalersConfig, resetSignalersConfigCache } from './loader.js'
