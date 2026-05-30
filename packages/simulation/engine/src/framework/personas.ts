/**
 * @fileoverview Persona configuration helpers for simulation scenarios
 *
 * persona() returns immutable PersonaConfig.
 * PERSONAS presets are pure functions.
 * Default values match production-safe settings.
 */

import type { PersonaConfig, PersonaType } from '../types/framework-types.js'

// =============================================================================
// PERSONA HELPER
// =============================================================================

/**
 * Options for configuring a persona.
 */
export interface PersonaOptions {
  /** Persona variant (e.g., 'default', 'aggressive', 'cautious'). Default: 'default' */
  readonly variant?: string
  /** Spawn rate per second. Default: 0.5 */
  readonly spawnRate?: number
  /** Actions to perform. Default: ['random'] */
  readonly actions?: readonly string[]
}

/**
 * Create a persona configuration with sensible defaults.
 *
 * @example
 * ```typescript
 * // Basic usage
 * persona('buyer', 10)
 *
 * // With custom options
 * persona('seller', 5, { spawnRate: 0.3, variant: 'aggressive' })
 *
 * // With specific actions
 * persona('admin', 2, { actions: ['moderate', 'review'] })
 * ```
 */
export function persona(type: PersonaType, count: number, options?: PersonaOptions): PersonaConfig {
  const variant = options?.variant ?? 'default'

  return Object.freeze({
    personaId: `${type}-${variant}`,
    count,
    spawnRate: options?.spawnRate ?? 0.5,
    actions: Object.freeze(options?.actions ?? ['random']),
  })
}

// =============================================================================
// PERSONA PRESETS
// =============================================================================

/**
 * Common persona presets for typical scenarios.
 *
 * @example
 * ```typescript
 * export const myScenario = defineLoadScenario({
 *   // ...
 *   personas: PERSONAS.standardMix(),
 * });
 * ```
 */
export const PERSONAS = {
  /**
   * Standard user mix for general testing.
   */
  standardMix: (): readonly PersonaConfig[] =>
    Object.freeze([persona('buyer', 10), persona('seller', 5), persona('admin', 1)]),

  /**
   * Full mix with all user types.
   */
  fullMix: (): readonly PersonaConfig[] =>
    Object.freeze([
      persona('buyer', 15),
      persona('seller', 10),
      persona('power-user', 3),
      persona('new-user', 5),
      persona('admin', 2),
      persona('support', 1),
    ]),

  /**
   * Minimal mix for quick tests.
   */
  minimal: (): readonly PersonaConfig[] =>
    Object.freeze([persona('buyer', 3), persona('seller', 2)]),

  /**
   * High-volume buyer scenario.
   * @param count - Number of buyers. Default: 20
   */
  buyerHeavy: (count = 20): readonly PersonaConfig[] =>
    Object.freeze([persona('buyer', count), persona('seller', Math.ceil(count / 4))]),

  /**
   * High-volume seller scenario.
   * @param count - Number of sellers. Default: 15
   */
  sellerHeavy: (count = 15): readonly PersonaConfig[] =>
    Object.freeze([persona('seller', count), persona('buyer', Math.ceil(count / 4))]),

  /**
   * Security testing with adversarial actors.
   */
  adversarial: (): readonly PersonaConfig[] =>
    Object.freeze([
      persona('attacker', 10, { spawnRate: 0.5 }),
      persona('buyer', 5, { spawnRate: 0.3 }),
      persona('admin', 2, { spawnRate: 0.1 }),
    ]),

  /**
   * Load test configuration.
   * @param users - Total number of users. Default: 100
   */
  loadTest: (users = 100): readonly PersonaConfig[] =>
    Object.freeze([
      persona('buyer', Math.floor(users * 0.6), { spawnRate: 2 }),
      persona('seller', Math.floor(users * 0.3), { spawnRate: 1 }),
      persona('power-user', Math.floor(users * 0.1), { spawnRate: 1.5 }),
    ]),

  /**
   * Spike test configuration.
   * @param baseUsers - Base number of users. Default: 50
   */
  spikeTest: (baseUsers = 50): readonly PersonaConfig[] =>
    Object.freeze([
      persona('buyer', baseUsers, { spawnRate: 5 }),
      persona('seller', Math.ceil(baseUsers / 3), { spawnRate: 3 }),
    ]),

  /**
   * Single persona type.
   * @param type - Persona type
   * @param count - Number of personas
   */
  only: (type: PersonaType, count: number): readonly PersonaConfig[] =>
    Object.freeze([persona(type, count)]),

  /**
   * Admin-only scenario.
   * @param count - Number of admins. Default: 3
   */
  adminsOnly: (count = 3): readonly PersonaConfig[] =>
    Object.freeze([persona('admin', count)]),
} as const

/**
 * Type for the PERSONAS object.
 */
export type PersonaPresets = typeof PERSONAS

// =============================================================================
// PERSONA UTILITIES
// =============================================================================

/**
 * Calculate total persona count from configs.
 */
export function getTotalPersonaCount(personas: readonly PersonaConfig[]): number {
  return personas.reduce((sum, p) => sum + p.count, 0)
}

/**
 * Calculate estimated requests per second based on personas.
 */
export function getEstimatedRps(personas: readonly PersonaConfig[]): number {
  return personas.reduce((sum, p) => sum + p.count * p.spawnRate, 0)
}

/**
 * Get unique persona types from configs.
 */
export function getPersonaTypes(personas: readonly PersonaConfig[]): readonly string[] {
  const types = new Set(
    personas
      .map((p) => p.personaId.split('-')[0])
      .filter((type): type is string => type !== undefined),
  )
  return Object.freeze([...types])
}
