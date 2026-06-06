/**
 * @fileoverview Simulation-specific type definitions.
 *
 * Core scenario types shared across the framework: the assertion shape and the
 * aggregated metrics struct produced by the load-window driver.
 */

import type { ScenarioMetricKey } from '../framework/scenario-metric-key.js'

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
export type AssertionOperator = LessThanOperator | GreaterThanOperator | EqualityAssertionOperator

/** A metric assertion evaluated after a scenario run */
export interface ScenarioAssertion {
  metric: ScenarioMetricKey
  operator: AssertionOperator
  value: number
  message: string
}

// =============================================================================
// EXECUTION TYPES
// =============================================================================

/** Aggregated performance metrics measured during a simulation run */
export interface SimulationMetrics {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  avgLatencyMs: number
  p50LatencyMs: number
  p95LatencyMs: number
  p99LatencyMs: number
  errorsGenerated: number
}
