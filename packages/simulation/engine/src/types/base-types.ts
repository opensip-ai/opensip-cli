/**
 * @fileoverview Simulation-specific type definitions
 *
 * Core types shared across the simulation framework including personas,
 * scenarios, chaos injection, execution, and service contracts.
 */

import type { ScenarioMetricKey } from '../framework/scenario-metric-key.js'

// =============================================================================
// PERSONA TYPES
// =============================================================================

/** Identifier for a persona type category */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- semantic alias documents the persona-id dimension
export type PersonaType = string

// =============================================================================
// SCENARIO TYPES
// =============================================================================

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

