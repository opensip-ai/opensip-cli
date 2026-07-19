import { err, ok } from '@opensip-cli/core';
import { listParentRuns, resolveParentRun } from '@opensip-cli/session-store';

import { readError } from './mcp-error.js';
import { executionRunReadError } from './session-results-read-helpers.js';

import type { McpReadError } from './mcp-error.js';
import type { McpExecutionRunDetailData, McpExecutionRunHistoryData } from './result-dto.js';
import type { ListExecutionRunsOptions, ShowExecutionRunOptions } from './results-read-port.js';
import type { Result } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

const SAFE_STORED_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Read one bounded parent-Run history page from the captured project scope.
 */
export function listStoredExecutionRuns(
  store: DataStore,
  projectRoot: string | undefined,
  opts: ListExecutionRunsOptions,
): Result<McpExecutionRunHistoryData, McpReadError> {
  try {
    const history = listParentRuns(store, {
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
      ...(projectRoot === undefined ? {} : { cwdWithin: projectRoot }),
    });
    return ok({
      type: 'run-history',
      runs: history.runs.map((run) => ({
        run,
        showCommand: `opensip runs show ${run.id} --json`,
      })),
      requestedLimit: history.requestedLimit,
      effectiveLimit: history.effectiveLimit,
      truncated: history.truncated,
    });
  } catch (error) {
    return err(executionRunReadError(error));
  }
}

/**
 * Read one exact parent Run and its bounded ordered steps from the captured
 * project scope.
 */
export function showStoredExecutionRun(
  store: DataStore,
  projectRoot: string | undefined,
  opts: ShowExecutionRunOptions,
): Result<McpExecutionRunDetailData, McpReadError> {
  try {
    const resolved = resolveParentRun(store, {
      runId: opts.runId,
      ...(opts.offset === undefined ? {} : { offset: opts.offset }),
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
      ...(projectRoot === undefined ? {} : { cwdWithin: projectRoot }),
    });
    if (resolved.status === 'not-found') {
      return err(readError('not-found', `Execution Run '${opts.runId}' was not found.`));
    }
    if (
      resolved.steps.some(
        (step) => step.sessionId !== undefined && !SAFE_STORED_ID.test(step.sessionId),
      )
    ) {
      return err(
        readError('execution-run-read-failed', 'Stored execution Run evidence could not be read.'),
      );
    }
    return ok({
      type: 'run-detail',
      run: resolved.run,
      steps: resolved.steps,
      offset: resolved.offset,
      limit: resolved.limit,
      total: resolved.total,
      ...(resolved.nextOffset === undefined ? {} : { nextOffset: resolved.nextOffset }),
      sessionFollowUps: resolved.steps.flatMap((step) =>
        step.sessionId === undefined
          ? []
          : [
              {
                runStepId: step.id,
                sessionId: step.sessionId,
                showCommand: `opensip sessions show ${step.sessionId} --json`,
              },
            ],
      ),
    });
  } catch (error) {
    return err(executionRunReadError(error));
  }
}
