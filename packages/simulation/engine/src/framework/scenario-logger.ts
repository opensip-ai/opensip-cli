/**
 * @fileoverview Per-scenario structured logger.
 *
 * Wraps the shared @opensip-tools/core logger with `evt: simulation.scenario.<level>`
 * tags and a stable `scenarioId` field, so every log entry from a running
 * scenario is greppable by scenario in the JSONL log stream. Each kind-
 * specific executor (load, chaos, …) constructs one of these per scenario
 * and passes it into the runtime as `ScenarioExecutionContext.logger`.
 *
 * The logger is identical across executor kinds — there's nothing
 * load-specific or chaos-specific about how a scenario reports info /
 * warn / error / debug. It lives in framework/ alongside the other
 * cross-kind runtime helpers (latency-tracker, personas, result-builder)
 * rather than being duplicated into each kinds/<kind>/executor.ts.
 */

import { logger } from '@opensip-tools/core'

import type { ScenarioLogger } from '../types/framework-types.js'

export function createScenarioLogger(scenarioId: string): ScenarioLogger {
  return {
    info: (message, data) => {
      logger.info({ evt: 'simulation.scenario.info', scenarioId, msg: message, ...data })
    },
    warn: (message, data) => {
      logger.warn({ evt: 'simulation.scenario.warn', scenarioId, msg: message, ...data })
    },
    error: (message, data) => {
      logger.error({
        evt: 'simulation.scenario.error',
        err: data?.err instanceof Error ? data.err : undefined,
        scenarioId,
        msg: message,
        ...data,
      })
    },
    debug: (message, data) => {
      logger.debug({ evt: 'simulation.scenario.debug', scenarioId, msg: message, ...data })
    },
  }
}
