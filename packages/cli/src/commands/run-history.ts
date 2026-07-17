import { type RunDetailResult, type RunHistoryResult } from '@opensip-cli/contracts';
import { ConfigurationError, SystemError } from '@opensip-cli/core';
import { listParentRuns, resolveParentRun } from '@opensip-cli/session-store';

import type { DataStore } from '@opensip-cli/datastore';

const FOLLOW_UP_ID = /^[A-Za-z0-9_-]{1,128}$/u;

/** Inputs for the bounded canonical parent-Run history projection. */
export interface ExecuteRunsListInput {
  readonly store: DataStore;
  readonly limit?: number;
}

/** Inputs for one exact, paged parent-Run detail projection. */
export interface ExecuteRunsShowInput {
  readonly store: DataStore;
  readonly runId: string;
  readonly offset?: number;
  readonly limit?: number;
}

/**
 * Project exact parent Runs into the customer-facing history DTO.
 *
 * Bounds and truncation are owned by session-store's snapshot reader. This
 * adapter adds only stable follow-up commands and never re-queries persistence.
 */
export function executeRunsList(input: ExecuteRunsListInput): RunHistoryResult {
  const history = listParentRuns(input.store, {
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  return {
    type: 'run-history',
    runs: history.runs.map((run) => ({
      run,
      showCommand: `opensip runs show ${run.id} --json`,
    })),
    requestedLimit: history.requestedLimit,
    effectiveLimit: history.effectiveLimit,
    truncated: history.truncated,
  };
}

/**
 * Project one exact parent Run and its bounded RunStep page.
 *
 * Linked Tool Sessions remain references. The normal parent detail path never
 * hydrates or embeds Session payloads; customers can follow the generated
 * `opensip sessions show` command when they need tool-specific evidence.
 */
export function executeRunsShow(input: ExecuteRunsShowInput): RunDetailResult {
  const resolved = resolveParentRun(input.store, {
    runId: input.runId,
    ...(input.offset === undefined ? {} : { offset: input.offset }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  if (resolved.status === 'not-found') {
    throw new ConfigurationError(`Parent Run '${input.runId}' was not found.`, {
      code: 'CLI.RUNS.NOT_FOUND',
    });
  }

  return {
    type: 'run-detail',
    run: resolved.run,
    steps: resolved.steps,
    offset: resolved.offset,
    limit: resolved.limit,
    total: resolved.total,
    ...(resolved.nextOffset === undefined ? {} : { nextOffset: resolved.nextOffset }),
    sessionFollowUps: resolved.steps.flatMap((step) => {
      if (step.sessionId === undefined) return [];
      if (!FOLLOW_UP_ID.test(step.sessionId)) {
        throw new SystemError('A linked Tool Session has an unsupported stored ID.', {
          code: 'SYSTEM.RUN_READ.UNSAFE_SESSION_ID',
        });
      }
      return [
        {
          runStepId: step.id,
          sessionId: step.sessionId,
          showCommand: `opensip sessions show ${step.sessionId} --json`,
        },
      ];
    }),
  };
}
