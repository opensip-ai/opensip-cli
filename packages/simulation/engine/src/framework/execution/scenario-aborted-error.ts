/**
 * @fileoverview ScenarioAbortedError - extracted to break circular dependency
 * between action-handlers.ts and execution-engine.ts.
 */

import { SystemError } from '@opensip-cli/core';

import { simulationErrorCatalog } from '../../errors/simulation-error-catalog.js';

/**
 * Error thrown when a scenario is aborted via AbortSignal.
 * This error must ALWAYS be re-thrown, never swallowed.
 *
 * Plan 00: retains scenarioId metadata and cancelled definition axes for
 * host normalizeFailure / reportFailure projection.
 */
export class ScenarioAbortedError extends SystemError {
  readonly scenarioId: string | undefined;

  constructor(scenarioId?: string) {
    super(scenarioId ? `Scenario ${scenarioId} was aborted` : 'Scenario was aborted', {
      code: 'SIMULATION.SCENARIO.ABORTED',
      definition: simulationErrorCatalog.require('SIMULATION.SCENARIO.ABORTED'),
      metadata: scenarioId ? { scenarioId } : {},
    });
    this.name = 'ScenarioAbortedError';
    this.scenarioId = scenarioId;
    Object.setPrototypeOf(this, ScenarioAbortedError.prototype);
  }
}
