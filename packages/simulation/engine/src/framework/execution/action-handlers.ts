// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
/**
 * @fileoverview Action execution handlers for simulation scenarios
 *
 * All handlers must check for abort before returning.
 * Metrics must be updated atomically.
 */

import type { Signal } from '@opensip-tools/core'
import { createSignal } from '@opensip-tools/core'

import type {
  ChaosConfig,
  Persona,
  PersonaConfig,
  SimulationMetrics,
} from '../../types/base-types.js'

import { ScenarioAbortedError } from './scenario-aborted-error.js'

// =============================================================================
// TYPES
// =============================================================================

/**
 * Result of a user action execution
 */
export interface SimulationActionResult {
  success: boolean
  duration: number
  error?: Error
  actionType?: string
}

/**
 * Result of chaos application
 */
export interface ChaosResult {
  applied: boolean
  type?: 'latency' | 'error' | 'timeout'
  additionalLatency?: number
  message?: string
}

/**
 * Context for simulation loop execution
 */
export interface SimulationLoopContext {
  metrics: SimulationMetrics
  signals: Signal[]
  scenarioId: string | null
  correlationId: string | null
  onSignal?: (signal: Signal) => void
  signalFilter?: (signal: { ruleId: string; severity: string }) => boolean
}

/**
 * Execution context for action handlers (minimal interface).
 * Any context that has these fields can be used.
 */
export interface ActionExecutionContext {
  readonly signal: AbortSignal
  readonly correlationId: string
  readonly scenarioId: string
  checkAborted: () => void
}

// =============================================================================
// SIGNAL EMISSION
// =============================================================================

function emitLoopSignal(signal: Signal, loopContext: SimulationLoopContext): void {
  if (loopContext.signalFilter && !loopContext.signalFilter(signal)) {
    return
  }
  loopContext.signals.push(signal)
  loopContext.metrics.findingsGenerated++
  loopContext.onSignal?.(signal)
}

// =============================================================================
// CHAOS INJECTION
// =============================================================================

/**
 * Apply chaos injection based on configuration.
 */
export function applyChaos(chaosConfig: ChaosConfig | undefined): ChaosResult {
  if (!chaosConfig?.enabled) {
    return { applied: false }
  }

  for (const injection of chaosConfig.types) {
    if (Math.random() < injection.probability) {
      switch (injection.config.type) {
        case 'latency':
          return {
            applied: true,
            type: 'latency',
            additionalLatency:
              injection.config.minMs +
              Math.random() * (injection.config.maxMs - injection.config.minMs),
          }
        case 'error':
          return {
            applied: true,
            type: 'error',
            message: injection.config.message,
          }
        case 'timeout':
          return { applied: true, type: 'timeout' }
      }
    }
  }

  return { applied: false }
}

// =============================================================================
// CHAOS HANDLING
// =============================================================================

/** Process a chaos injection result, updating metrics and emitting signals for errors/timeouts */
export function handleChaosInjection(
  chaosResult: ChaosResult,
  loopContext: SimulationLoopContext,
): boolean {
  if (!chaosResult.applied) {
    return false
  }

  const { metrics, scenarioId, correlationId } = loopContext

  if (chaosResult.type === 'error') {
    metrics.failedRequests++
    metrics.totalRequests++
    metrics.errorsGenerated++
    const signal = createSignal({
      source: 'simulation',
      provider: 'opensip',
      severity: 'medium',
      category: 'error',
      ruleId: 'sim:chaos-error-injected',
      message: chaosResult.message ?? 'Chaos error injected',
      suggestion:
        'This is expected chaos testing behavior - no action needed unless error rate exceeds thresholds',
      fix: { action: 'investigate', confidence: 0.9 },
      metadata: {
        endpoint: 'chaos-injection',
        traceId: correlationId,
        personaId: null,
        scenarioId,
        statusCode: 500,
        latencyMs: null,
      },
    })
    emitLoopSignal(signal, loopContext)
    return true
  }

  if (chaosResult.type === 'timeout') {
    metrics.failedRequests++
    metrics.totalRequests++
    metrics.errorsGenerated++
    const signal = createSignal({
      source: 'simulation',
      provider: 'opensip',
      severity: 'medium',
      category: 'error',
      ruleId: 'sim:chaos-timeout-injected',
      message: 'Chaos timeout injected',
      suggestion:
        'This is expected chaos testing behavior - no action needed unless timeout rate exceeds thresholds',
      fix: { action: 'investigate', confidence: 0.9 },
      metadata: {
        endpoint: 'chaos-injection',
        traceId: correlationId,
        personaId: null,
        scenarioId,
        statusCode: 504,
        latencyMs: null,
      },
    })
    emitLoopSignal(signal, loopContext)
    return true
  }

  return false
}

// =============================================================================
// ACTION RESULT HANDLING
// =============================================================================

/** Record a completed action result, updating metrics and emitting a signal on failure */
export function handleActionSuccess(
  result: SimulationActionResult,
  persona: Persona,
  loopContext: SimulationLoopContext,
  updateLatency: (metrics: SimulationMetrics, latency: number) => void,
): void {
  const { metrics, scenarioId, correlationId } = loopContext

  metrics.totalRequests++
  updateLatency(metrics, result.duration)

  if (result.success) {
    metrics.successfulRequests++
    return
  }

  metrics.failedRequests++
  metrics.errorsGenerated++
  const signal = createSignal({
    source: 'simulation',
    provider: 'opensip',
    severity: 'high',
    category: 'error',
    ruleId: 'sim:action-failed',
    message: result.error?.message ?? 'Action failed',
    suggestion: 'Investigate the action failure and check for API errors or invalid state',
    fix: { action: 'investigate', confidence: 0.5 },
    metadata: {
      endpoint: result.actionType ?? 'unknown-action',
      traceId: correlationId,
      personaId: persona.id,
      scenarioId,
      latencyMs: result.duration,
      statusCode: null,
    },
  })
  emitLoopSignal(signal, loopContext)
}

/** Record an action exception, updating metrics and emitting an error signal */
export function handleActionError(
  error: unknown,
  persona: Persona,
  loopContext: SimulationLoopContext,
  updateLatency: (metrics: SimulationMetrics, latency: number) => void,
): void {
  const { metrics, scenarioId, correlationId } = loopContext

  metrics.totalRequests++
  metrics.failedRequests++
  metrics.errorsGenerated++
  updateLatency(metrics, 0)

  const signal = createSignal({
    source: 'simulation',
    provider: 'opensip',
    severity: 'high',
    category: 'error',
    ruleId: 'sim:action-exception',
    message: error instanceof Error ? error.message : 'Unknown error',
    suggestion: 'Check for unhandled exceptions in the action handler',
    fix: { action: 'investigate', confidence: 0.3 },
    metadata: {
      endpoint: 'action-execution',
      traceId: correlationId,
      personaId: persona.id,
      scenarioId,
      latencyMs: 0,
      statusCode: null,
    },
  })
  emitLoopSignal(signal, loopContext)
}

// =============================================================================
// TICK EXECUTION
// =============================================================================

/**
 * Execute all requests for a single tick.
 */
export async function executeTickRequests<TCtx extends ActionExecutionContext>(
  requestCount: number,
  config: { personas: readonly PersonaConfig[]; chaosConfig?: ChaosConfig },
  ctx: TCtx,
  executeAction: (
    persona: Persona,
    ctx: TCtx,
  ) => Promise<SimulationActionResult>,
  resolvePersona: (config: PersonaConfig) => Persona,
  loopContext: SimulationLoopContext,
  updateLatency: (metrics: SimulationMetrics, latency: number) => void,
): Promise<void> {
  for (let i = 0; i < requestCount; i++) {
    ctx.checkAborted()

    const personaConfig = config.personas[Math.floor(Math.random() * config.personas.length)]
    if (!personaConfig) continue

    const persona = resolvePersona(personaConfig)

    // Apply chaos
    const chaosResult = applyChaos(config.chaosConfig)
    if (handleChaosInjection(chaosResult, loopContext)) {
      continue
    }

    // Execute action
    try {
      const result = await executeAction(persona, ctx)
      void handleActionSuccess(result, persona, loopContext, updateLatency)
    } catch (error) {
      if (error instanceof ScenarioAbortedError) {
        throw error
      }
      void handleActionError(error, persona, loopContext, updateLatency)
    }
  }
}

// ScenarioAbortedError imported from scenario-aborted-error (single canonical definition)
