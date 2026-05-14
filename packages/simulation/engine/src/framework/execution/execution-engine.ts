// @fitness-ignore-file file-length-limits -- Simulation engine: orchestrates scenario lifecycle with tightly coupled phases that resist decomposition
// @fitness-ignore-file module-coupling-metrics -- simulation engine: exports scenario lifecycle functions and types consumed by simulation runners
/**
 * @fileoverview Core simulation execution engine
 *
 * Provides the main simulation loop, scenario executor wrapper,
 * and utility functions for running simulation scenarios.
 */

import { randomBytes } from 'node:crypto'

import { logger as coreLogger } from '@opensip-tools/core'
import type { Signal, SignalSeverity, SignalCategory, FixHint } from '@opensip-tools/core'
import { createSignal } from '@opensip-tools/core'

import type {
  SimulationRun,
  SimulationMetrics,
  ScenarioAssertion,
  Persona,
  PersonaConfig,
  ScenarioType,
  ChaosConfig,
} from '../../types/base-types.js'
import { evaluateOperator } from '../assertions.js'
import { createEmptyMetrics } from '../result-builder.js'

import type { SimulationActionResult, SimulationLoopContext } from './action-handlers.js'
import { executeTickRequests } from './action-handlers.js'
import { LatencyTracker } from './latency-tracker.js'
import { ScenarioAbortedError } from './scenario-aborted-error.js'

export { ScenarioAbortedError }

// =============================================================================
// EXECUTOR TYPES
// =============================================================================

/**
 * Scenario metadata - static information about the scenario
 */
export interface ScenarioMetadata {
  id: string
  name: string
  description: string
  type: ScenarioType
  tags: string[]
}

/**
 * Scenario configuration - runtime parameters
 */
export interface ExecutorScenarioConfig {
  personas: PersonaConfig[]
  duration: number
  rampUp: number
  targetRps: number
  chaosConfig?: ChaosConfig | undefined
  assertions: ScenarioAssertion[]
}

/**
 * Execution context provided to scenario executors.
 */
export interface ExecutorContext {
  signal: AbortSignal
  correlationId: string
  logger: ExecutorLogger
  checkAborted: () => void
  runId: string
  scenarioId: string
  recipeId?: string | undefined
}

/**
 * Logger interface for executor context.
 */
export interface ExecutorLogger {
  info(entry: Record<string, unknown>): void
  warn(entry: Record<string, unknown>): void
  error(entry: Record<string, unknown>): void
  debug(entry: Record<string, unknown>): void
}

/**
 * Result returned by scenario executor's execute method.
 */
export interface ExecutorResult {
  metrics: SimulationMetrics
  signals: Signal[]
  assertionsPassed: boolean
  failedAssertions?: Array<{ assertion: ScenarioAssertion; actual: number }>
}

/**
 * Scenario executor interface - the contract for scenario implementations.
 */
export interface ScenarioExecutor {
  metadata: ScenarioMetadata
  defaultConfig: ExecutorScenarioConfig
  execute: (
    config: ExecutorScenarioConfig,
    ctx: ExecutorContext,
  ) => Promise<ExecutorResult>
}

/**
 * Options for creating a scenario runner
 */
export interface CreateScenarioOptions {
  persistReports?: boolean
  persistLogs?: boolean
  onSignal?: (signal: unknown) => void
  onMetrics?: (metrics: SimulationMetrics) => void
  onComplete?: (run: SimulationRun) => void
}

/**
 * Runnable scenario interface - what createScenario returns
 */
export interface ExecutorRunnableScenario {
  metadata: ScenarioMetadata
  defaultConfig: ExecutorScenarioConfig
  run: (
    options?: {
      configOverrides?: Partial<ExecutorScenarioConfig>
      recipeId?: string
    },
    signal?: AbortSignal,
  ) => Promise<SimulationRun>
}

// =============================================================================
// ASSERTION VALIDATION
// =============================================================================

/**
 * Validate assertions against metrics.
 */
export function validateAssertions(
  metrics: SimulationMetrics,
  assertions: ScenarioAssertion[],
): { passed: boolean; failed: Array<{ assertion: ScenarioAssertion; actual: number }> } {
  if (!Array.isArray(assertions)) {
    return { passed: false, failed: [] }
  }

  const failed: Array<{ assertion: ScenarioAssertion; actual: number }> = []

  for (const assertion of assertions) {
    const actual = getMetricValue(metrics, assertion.metric)
    const passed = evaluateOperator(actual, assertion.operator, assertion.value)

    if (!passed) {
      failed.push({ assertion, actual })
    }
  }

  return { passed: failed.length === 0, failed }
}

/**
 * Get metric value by name.
 */
export function getMetricValue(metrics: SimulationMetrics, metric: string): number {
  switch (metric) {
    case 'error_rate':
      return metrics.totalRequests > 0 ? metrics.failedRequests / metrics.totalRequests : 0
    case 'success_rate':
      return metrics.totalRequests > 0 ? metrics.successfulRequests / metrics.totalRequests : 1
    case 'recovery_rate':
      return metrics.errorsGenerated > 0 ? 1 - metrics.failedRequests / metrics.errorsGenerated : 1
    case 'p50_latency':
    case 'p50_latency_ms':
      return metrics.p50LatencyMs
    case 'p95_latency':
    case 'p95_latency_ms':
      return metrics.p95LatencyMs
    case 'p99_latency':
    case 'p99_latency_ms':
      return metrics.p99LatencyMs
    case 'avg_latency':
    case 'avg_latency_ms':
      return metrics.avgLatencyMs
    case 'total_requests':
      return metrics.totalRequests
    case 'failed_requests':
      return metrics.failedRequests
    case 'findings_generated':
      return metrics.findingsGenerated
    default:
      return 0
  }
}

// =============================================================================
// METRICS UTILITIES
// =============================================================================


/**
 * Update latency metrics with a new sample.
 *
 * WARNING: Percentile values (p50, p95, p99) are rough estimates derived from
 * the running average. For accurate percentiles, use LatencyTracker instead.
 * This function is intended for quick in-loop metric updates where
 * maintaining a full sample set is impractical.
 */
export function updateLatencyMetrics(metrics: SimulationMetrics, latency: number): void {
  const n = metrics.totalRequests
  if (n === 0) {
    metrics.avgLatencyMs = latency
    metrics.p50LatencyMs = latency
    metrics.p95LatencyMs = latency
    metrics.p99LatencyMs = latency
  } else {
    metrics.avgLatencyMs = (metrics.avgLatencyMs * (n - 1) + latency) / n
    // Rough estimates — use LatencyTracker.getLatencySnapshot() for real percentiles
    metrics.p50LatencyMs = metrics.avgLatencyMs * 0.9
    metrics.p95LatencyMs = metrics.avgLatencyMs * 1.5
    metrics.p99LatencyMs = metrics.avgLatencyMs * 2
  }
}

// =============================================================================
// SLEEP UTILITY
// =============================================================================

/**
 * Sleep for a specified duration with abort support.
 * @throws {ScenarioAbortedError} When the abort signal is triggered
 */
export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ScenarioAbortedError())
      return
    }

    const abortHandler = () => {
      clearTimeout(timeout)
      reject(new ScenarioAbortedError())
    }

    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abortHandler)
      resolve()
    }, ms)

    signal.addEventListener('abort', abortHandler, { once: true })
  })
}

// =============================================================================
// SIMULATION LOOP
// =============================================================================

/**
 * Options for running a simulation loop.
 */
export interface SimulationLoopOptions {
  config: ExecutorScenarioConfig
  ctx: ExecutorContext
  executeAction: (
    persona: Persona,
    ctx: ExecutorContext,
  ) => Promise<SimulationActionResult>
  resolvePersona: (config: PersonaConfig) => Persona
  onMetricsUpdate?: (metrics: SimulationMetrics) => void
  onSignal?: (signal: Signal) => void
  signalFilter?: (signal: { ruleId: string; severity: string }) => boolean
  tickIntervalMs?: number
}

/**
 * Result of simulation loop.
 */
export interface SimulationLoopResult {
  metrics: SimulationMetrics
  signals: Signal[]
}

/**
 * Run a simulation loop for the configured duration.
 *
 * The core simulation engine that:
 * 1. Calculates RPS based on ramp-up progress
 * 2. Executes user actions via the provided executor
 * 3. Applies chaos injection
 * 4. Tracks metrics
 * 5. Emits signals on errors
 */
export async function runSimulationLoop(
  options: SimulationLoopOptions,
): Promise<SimulationLoopResult> {
  const {
    config,
    ctx,
    executeAction,
    resolvePersona,
    onMetricsUpdate,
    onSignal,
    signalFilter,
    tickIntervalMs = 100,
  } = options

  const loopContext: SimulationLoopContext = {
    metrics: createEmptyMetrics(),
    signals: [],
    scenarioId: ctx.scenarioId,
    correlationId: ctx.correlationId,
    ...(onSignal !== undefined ? { onSignal } : {}),
    ...(signalFilter !== undefined ? { signalFilter } : {}),
  }

  const latencyTracker = new LatencyTracker()
  const startTime = Date.now()
  const durationMs = config.duration * 1000
  const rampUpMs = config.rampUp * 1000

  const trackLatency = (metrics: SimulationMetrics, latency: number): void => {
    latencyTracker.record(latency)
    const n = metrics.totalRequests
    if (n === 0) {
      metrics.avgLatencyMs = latency
    } else {
      metrics.avgLatencyMs = (metrics.avgLatencyMs * (n - 1) + latency) / n
    }
  }

  for (;;) {
    ctx.checkAborted()

    const elapsed = Date.now() - startTime
    if (elapsed >= durationMs) {
      break
    }

    const rampUpProgress = rampUpMs === 0 ? 1 : Math.min(1, elapsed / rampUpMs)
    const currentRps = config.targetRps * rampUpProgress
    const requestsThisTick = Math.floor(currentRps / (1000 / tickIntervalMs))

    await executeTickRequests(
      requestsThisTick,
      config,
      ctx,
      executeAction,
      resolvePersona,
      loopContext,
      trackLatency,
    )

    void onMetricsUpdate?.(loopContext.metrics)

    await sleepWithAbort(tickIntervalMs, ctx.signal)
  }

  const snapshot = latencyTracker.getLatencySnapshot()
  loopContext.metrics.p50LatencyMs = snapshot.p50LatencyMs
  loopContext.metrics.p95LatencyMs = snapshot.p95LatencyMs
  loopContext.metrics.p99LatencyMs = snapshot.p99LatencyMs

  return { metrics: loopContext.metrics, signals: loopContext.signals }
}

/**
 * Helper to create a standard executor result from simulation loop result.
 */
export function createExecutorResult(
  loopResult: SimulationLoopResult,
  assertions: ExecutorScenarioConfig['assertions'],
): ExecutorResult {
  const { metrics, signals } = loopResult
  const validationResult = validateAssertions(metrics, assertions)

  return {
    metrics,
    signals,
    assertionsPassed: validationResult.passed,
    ...(validationResult.failed.length > 0 ? { failedAssertions: validationResult.failed } : {}),
  }
}

// =============================================================================
// SIGNAL HELPERS
// =============================================================================

/**
 * Input for emitSimulationSignal() helper.
 */
export interface EmitSignalInput {
  readonly ruleId: string
  readonly severity: SignalSeverity
  readonly category: SignalCategory
  readonly message: string
  readonly suggestion: string
  readonly endpoint: string
  readonly ctx: ExecutorContext
  readonly fix: FixHint
  readonly latencyMs: number | null
  readonly statusCode: number | null
}

/**
 * Create a simulation signal when an issue is detected.
 */
export function emitSimulationSignal(data: EmitSignalInput): Signal {
  return createSignal({
    source: 'simulation',
    provider: 'opensip',
    severity: data.severity,
    category: data.category,
    ruleId: `sim:${data.ruleId}`,
    message: data.message,
    suggestion: data.suggestion,
    fix: data.fix,
    metadata: {
      endpoint: data.endpoint,
      traceId: data.ctx.correlationId,
      personaId: null,
      scenarioId: data.ctx.scenarioId,
      latencyMs: data.latencyMs,
      statusCode: data.statusCode,
    },
  })
}

// =============================================================================
// SCENARIO FACTORY
// =============================================================================

function generateRunId(): string {
  const timestamp = Date.now().toString(36)
  const random = randomBytes(3).toString('hex')
  return `RUN_${timestamp}_${random}`.toUpperCase()
}

/** @throws {ScenarioAbortedError} When the signal has been aborted */
function createAbortChecker(signal: AbortSignal, scenarioId: string): () => void {
  return (
    /** @throws {ScenarioAbortedError} When the signal has been aborted */
    () => {
      if (signal.aborted) {
        throw new ScenarioAbortedError(scenarioId)
      }
    }
  )
}

/**
 * Create a structured logger adapter for scenarios.
 */
function createStructuredLogger(): ExecutorLogger {
  return {
    info: (entry) => coreLogger.info({ ...entry, module: 'simulation:executor' }),
    warn: (entry) => coreLogger.warn({ ...entry, module: 'simulation:executor' }),
    error: (entry) => coreLogger.error({ ...entry, module: 'simulation:executor' }),
    debug: (entry) => coreLogger.debug({ ...entry, module: 'simulation:executor' }),
  }
}

/**
 * Creates a RunnableScenario from a ScenarioExecutor with standardized cross-cutting concerns.
 *
 * The wrapper handles:
 * - Correlation ID management
 * - Performance timing
 * - Logging (start, complete, error, abort events)
 * - Error handling (ScenarioAbortedError is always re-thrown)
 * - Assertion validation
 *
 * @throws {ScenarioAbortedError} When the scenario is aborted via AbortSignal (re-thrown from run)
 */
export function createScenario(
  executor: ScenarioExecutor,
  options: CreateScenarioOptions = {},
): ExecutorRunnableScenario {
  return {
    metadata: executor.metadata,
    defaultConfig: executor.defaultConfig,
    run:
      /** @throws {ScenarioAbortedError} When the scenario is aborted via AbortSignal */
      async (runOptions, signal): Promise<SimulationRun> => {
      const correlationId = `scenario-${executor.metadata.id}-${Date.now().toString(36)}`
      const runId = generateRunId()
      const startTime = Date.now()
      const logger = createStructuredLogger()

      const config: ExecutorScenarioConfig = {
        ...executor.defaultConfig,
        ...runOptions?.configOverrides,
      }

      const effectiveSignal = signal ?? new AbortController().signal

      const run: SimulationRun = {
        id: runId,
        scenarioId: executor.metadata.id,
        ...(runOptions?.recipeId ? { recipeId: runOptions.recipeId } : {}),
        mode: 'local',
        status: 'running',
        startedAt: new Date().toISOString(),
        metrics: createEmptyMetrics(),
        signals: [],
      }

      logger.info({
        evt: 'simulation.scenario.execution.start',
        msg: `Starting scenario ${executor.metadata.name}`,
        scenarioId: executor.metadata.id,
        runId,
        duration: config.duration,
        targetRps: config.targetRps,
      })

      try {
        if (effectiveSignal.aborted) {
          throw new ScenarioAbortedError(executor.metadata.id)
        }

        const ctx: ExecutorContext = {
          signal: effectiveSignal,
          correlationId,
          logger,
          checkAborted: createAbortChecker(effectiveSignal, executor.metadata.id),
          runId,
          scenarioId: executor.metadata.id,
          ...(runOptions?.recipeId ? { recipeId: runOptions.recipeId } : {}),
        }

        const executorResult = await executor.execute(config, ctx)

        run.metrics = executorResult.metrics
        run.signals = executorResult.signals
        run.status = executorResult.assertionsPassed ? 'completed' : 'failed'
        run.completedAt = new Date().toISOString()

        if (!executorResult.assertionsPassed && executorResult.failedAssertions) {
          run.error = `Assertions failed: ${executorResult.failedAssertions
            .map((f) => f.assertion.message)
            .join(', ')}`
        }

        logger.info({
          evt: 'simulation.scenario.execution.complete',
          msg: `Completed scenario ${executor.metadata.name}`,
          scenarioId: executor.metadata.id,
          runId,
          status: run.status,
          duration: Date.now() - startTime,
          totalRequests: run.metrics.totalRequests,
        })

        options.onComplete?.(run)
        return run
      } catch (error) {
        if (error instanceof ScenarioAbortedError) {
          logger.info({
            evt: 'simulation.scenario.execution.aborted',
            msg: `Scenario ${executor.metadata.name} was aborted`,
            scenarioId: executor.metadata.id,
            runId,
          })

          run.status = 'cancelled'
          run.completedAt = new Date().toISOString()
          run.error = 'Scenario was aborted'
          throw error
        }

        const structuredErr = error instanceof Error ? error : new Error(String(error))
        logger.error({
          evt: 'simulation.scenario.execution.error',
          msg: `Scenario ${executor.metadata.name} failed: ${structuredErr.message}`,
          err: structuredErr,
          scenarioId: executor.metadata.id,
          runId,
          duration: Date.now() - startTime,
        })

        run.status = 'failed'
        run.completedAt = new Date().toISOString()
        run.error = structuredErr.message

        options.onComplete?.(run)
        return run
      }
    },
  }
}

/**
 * Standalone checkAborted helper for use outside the executor pattern.
 * @throws {ScenarioAbortedError} When the abort signal has been triggered
 */
export function scenarioAborted(signal: AbortSignal | undefined, scenarioId?: string): void {
  if (signal?.aborted) {
    throw new ScenarioAbortedError(scenarioId)
  }
}

// =============================================================================
// STANDARD EXECUTOR FACTORY
// =============================================================================

/**
 * Configuration for creating a standard executor.
 */
export interface StandardExecutorConfig {
  id: string
  name: string
  description: string
  type: ScenarioType
  tags: string[]
  personas: PersonaConfig[]
  duration: number
  rampUp: number
  targetRps: number
  assertions: ScenarioAssertion[]
  chaosConfig?: ChaosConfig
  /** Function to resolve a PersonaConfig to a Persona instance */
  resolvePersona: (config: PersonaConfig) => Persona
  /** Function to execute a random user action for a persona */
  executeAction: (persona: Persona, ctx: ExecutorContext) => Promise<SimulationActionResult>
}

/**
 * Create a ScenarioExecutor with standard execution logic.
 *
 * All scenarios using standard execution logic (runSimulationLoop)
 * should use this helper to avoid code duplication.
 */
export function createStandardExecutor(config: StandardExecutorConfig): ScenarioExecutor {
  const eventPrefix = `scenario.${config.id.replace(/-/g, '_')}`

  return {
    metadata: {
      id: config.id,
      name: config.name,
      description: config.description,
      type: config.type,
      tags: config.tags,
    },

    defaultConfig: {
      personas: config.personas,
      duration: config.duration,
      rampUp: config.rampUp,
      targetRps: config.targetRps,
      assertions: config.assertions,
      ...(config.chaosConfig ? { chaosConfig: config.chaosConfig } : {}),
    },

    async execute(scenarioConfig: ExecutorScenarioConfig, ctx: ExecutorContext) {
      // @fitness-ignore-next-line logging-standards -- evt uses template literal for dynamic scenario prefix
      ctx.logger.info({
        evt: `${eventPrefix}.execute.start`,
        msg: `Starting ${config.name} simulation`,
        corr_id: ctx.correlationId,
        duration: scenarioConfig.duration,
        targetRps: scenarioConfig.targetRps,
      })

      const loopResult = await runSimulationLoop({
        config: scenarioConfig,
        ctx,
        executeAction: config.executeAction,
        resolvePersona: config.resolvePersona,
        onMetricsUpdate: (metrics) => {
          if (metrics.totalRequests > 0 && metrics.totalRequests % 100 === 0) {
            // @fitness-ignore-next-line logging-standards -- evt uses template literal for dynamic scenario prefix
            ctx.logger.info({
              evt: `${eventPrefix}.metrics.update`,
              msg: `${config.name} simulation progress`,
              corr_id: ctx.correlationId,
              totalRequests: metrics.totalRequests,
              errorRate: metrics.failedRequests / metrics.totalRequests,
            })
          }
        },
      })

      // @fitness-ignore-next-line logging-standards -- evt uses template literal for dynamic scenario prefix
      ctx.logger.info({
        evt: `${eventPrefix}.execute.complete`,
        msg: `${config.name} simulation complete`,
        corr_id: ctx.correlationId,
        totalRequests: loopResult.metrics.totalRequests,
      })

      return createExecutorResult(loopResult, scenarioConfig.assertions)
    },
  }
}
