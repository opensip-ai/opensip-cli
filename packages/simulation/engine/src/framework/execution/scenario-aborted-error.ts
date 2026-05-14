// @fitness-ignore-file project-readme-existence -- internal module, not a package root
/**
 * @fileoverview ScenarioAbortedError - extracted to break circular dependency
 * between action-handlers.ts and execution-engine.ts.
 */

import { SystemError } from '@opensip-tools/core'

/**
 * Error thrown when a scenario is aborted via AbortSignal.
 * This error must ALWAYS be re-thrown, never swallowed.
 */
export class ScenarioAbortedError extends SystemError {
  readonly scenarioId: string | undefined

  constructor(scenarioId?: string) {
    super(scenarioId ? `Scenario ${scenarioId} was aborted` : 'Scenario was aborted', {
      code: 'SIMULATION.SCENARIO.ABORTED',
      severity: 'medium',
      metadata: scenarioId ? { scenarioId } : {},
    })
    this.name = 'ScenarioAbortedError'
    this.scenarioId = scenarioId
    Object.setPrototypeOf(this, ScenarioAbortedError.prototype)
  }
}
