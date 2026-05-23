/**
 * @fileoverview Simulation-specific type definitions
 *
 * Core types shared across the simulation framework including personas,
 * scenarios, chaos injection, execution, and service contracts.
 */

import type { ScenarioMetricKey } from '../framework/resolve-metric.js'
import type { Signal } from '@opensip-tools/core'

// =============================================================================
// PERSONA TYPES
// =============================================================================

/** Identifier for a persona type category */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- semantic alias documents the persona-id dimension
export type PersonaType = string

/** Behavioral mode for a simulation persona */
type PersonaBehavior = 'normal' | 'aggressive' | 'cautious' | 'erratic'

/** A simulation persona with behavioral attributes and action probabilities */
export interface Persona {
  id: string
  type: PersonaType
  name: string
  behavior: PersonaBehavior
  attributes: PersonaAttributes
  actionProbabilities: ActionProbabilities
}

/** Configurable attributes defining a persona's behavioral profile */
interface PersonaAttributes {
  trustScore: number // 0-100
  activityLevel: 'low' | 'medium' | 'high'
  preferredCategories: string[]
  priceRange: { min: number; max: number }
  responseTime: { min: number; max: number } // milliseconds
}

/** Map of action names to their probability weights */
type ActionProbabilities = Record<string, number>;

// =============================================================================
// SCENARIO TYPES
// =============================================================================

/** Configuration for a persona within a scenario */
export interface PersonaConfig {
  personaId: string
  count: number
  spawnRate: number // per second
  actions: string[] // action sequence or 'random'
}

/** Less-than comparison operators */
type LessThanOperator = 'lt' | 'lte'
/** Greater-than comparison operators */
type GreaterThanOperator = 'gt' | 'gte'
/** Equality comparison operators */
type EqualityAssertionOperator = 'eq' | 'neq'
/** All assertion comparison operators */
/** All assertion comparison operators */
export type AssertionOperator = LessThanOperator | GreaterThanOperator | EqualityAssertionOperator

/** A metric assertion evaluated after a scenario run */
export interface ScenarioAssertion {
  metric: ScenarioMetricKey
  operator: AssertionOperator
  value: number
  message: string
}

// =============================================================================
// CHAOS TYPES
// =============================================================================

/** Types of chaos that can be injected during simulation */
export type ChaosType =
  | 'latency'
  | 'error'
  | 'timeout'
  | 'rate-limit'
  | 'connection-drop'
  | 'data-corruption'

/** Top-level chaos injection configuration for a scenario */
export interface ChaosConfig {
  enabled: boolean
  probability: number // 0-1
  types: ChaosInjection[]
}

/** A single chaos injection rule targeting a service or endpoint */
interface ChaosInjection {
  type: ChaosType
  target: string // service or endpoint pattern
  probability: number // 0-1
  config: ChaosTypeConfig
}

/** Union of all chaos-type-specific configuration objects */
type ChaosTypeConfig =
  | LatencyChaosConfig
  | ErrorChaosConfig
  | TimeoutChaosConfig
  | RateLimitChaosConfig
  | ConnectionDropChaosConfig
  | DataCorruptionChaosConfig

/** Configuration for injecting artificial latency */
interface LatencyChaosConfig {
  type: 'latency'
  minMs: number
  maxMs: number
}

/** Configuration for injecting error responses */
interface ErrorChaosConfig {
  type: 'error'
  statusCode: number
  message: string
}

/** Configuration for injecting request timeouts */
interface TimeoutChaosConfig {
  type: 'timeout'
  afterMs: number
}

/** Configuration for injecting rate limiting */
interface RateLimitChaosConfig {
  type: 'rate-limit'
  limit: number
  windowMs: number
}

/** Configuration for injecting connection drops */
interface ConnectionDropChaosConfig {
  type: 'connection-drop'
  afterBytes?: number
}

/** Configuration for injecting data corruption */
interface DataCorruptionChaosConfig {
  type: 'data-corruption'
  fields: string[]
  corruptionType: 'truncate' | 'randomize' | 'null'
}

// =============================================================================
// EXECUTION TYPES
// =============================================================================

/** Environment in which a simulation executes */
type ExecutionMode = 'local' | 'docker' | 'ephemeral-aws' | 'staging'

/** Run is waiting or actively executing */
type ActiveRunStatus = 'pending' | 'running'
/** Run has reached a terminal state */
type TerminalRunStatus = 'completed' | 'failed' | 'cancelled'
/** All simulation run statuses */
/** All simulation run statuses */
type SimulationRunStatus = ActiveRunStatus | TerminalRunStatus

/** A single simulation execution with its metrics and signals */
export interface SimulationRun {
  id: string
  recipeId?: string | undefined
  scenarioId: string
  targetId?: string | undefined
  mode: ExecutionMode
  status: SimulationRunStatus
  startedAt?: string | undefined
  completedAt?: string | undefined
  metrics: SimulationMetrics
  signals: Signal[]
  error?: string | undefined
}

/** Aggregated performance metrics from a simulation run */
export interface SimulationMetrics {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  avgLatencyMs: number
  p50LatencyMs: number
  p95LatencyMs: number
  p99LatencyMs: number
  errorsGenerated: number
  findingsGenerated: number
}

