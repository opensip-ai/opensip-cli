/**
 * @fileoverview Per-scenario structured logger.
 *
 * Wraps {@link createToolLogger} with `evt: simulation.scenario.<level>` tags and
 * a stable `scenarioId` field, so every log entry from a running scenario is
 * greppable by scenario in the JSONL log stream.
 */

import { createToolLogger } from '@opensip-cli/core';

import type { ScenarioLogger } from '../types/framework-types.js';

export function createScenarioLogger(scenarioId: string): ScenarioLogger {
  const logger = createToolLogger('simulation:scenario');
  return {
    info: (message, data) => {
      logger.info({
        evt: 'simulation.scenario.info',
        scenarioId,
        msg: message,
        ...data,
      });
    },
    warn: (message, data) => {
      logger.warn({
        evt: 'simulation.scenario.warn',
        scenarioId,
        msg: message,
        ...data,
      });
    },
    error: (message, data) => {
      logger.error({
        evt: 'simulation.scenario.error',
        err: data?.err instanceof Error ? data.err : undefined,
        scenarioId,
        msg: message,
        ...data,
      });
    },
    debug: (message, data) => {
      logger.debug({
        evt: 'simulation.scenario.debug',
        scenarioId,
        msg: message,
        ...data,
      });
    },
  };
}
