import { readError } from './mcp-error.js';

import type { McpReadError } from './mcp-error.js';
import type { LatestFindingsOptions, McpResultReplay, RunSummary } from './result-dto.js';
import type { HistorySession } from '@opensip-cli/contracts';

const EXECUTION_RUN_VALIDATION_CODES = new Set([
  'VALIDATION.RUN_READ.LIST_LIMIT_INVALID',
  'SESSION.WRITE.RECORD_INVALID',
  'SESSION.READ.BOUND_INVALID',
  'VALIDATION.RUN_READ.STEP_LIMIT_INVALID',
]);

/** Map a `sessions list` row to the lean agent-facing Run summary. */
export function toRunSummary(session: HistorySession): RunSummary {
  return {
    id: session.id,
    tool: session.tool,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    cwd: session.cwd,
    durationMs: session.durationMs,
    score: session.score,
    passed: session.passed,
    ...(session.cliVersion === undefined ? {} : { cliVersion: session.cliVersion }),
    ...(session.engineVersion === undefined ? {} : { engineVersion: session.engineVersion }),
    showCommand: session.showCommand,
    ...(session.ledger === undefined ? {} : { ledger: session.ledger }),
    ...(session.summary ? { summary: session.summary } : {}),
  };
}

/** Convert the findings request vocabulary into the shared agent filters. */
export function severityFilters(opts: LatestFindingsOptions): string[] {
  const filters: string[] = [];
  if (opts.severity === 'errors') filters.push('errors-only');
  else if (opts.severity === 'warnings') filters.push('warnings-only');
  if (opts.limit !== undefined) filters.push(`top:${String(opts.limit)}`);
  return filters;
}

/** Return filter metadata only when a request applied at least one filter. */
export function filterMeta(
  filters: readonly string[] | undefined,
  originalSignalCount: number,
  returnedSignalCount: number,
): Pick<
  McpResultReplay<unknown>,
  'filtersApplied' | 'originalSignalCount' | 'returnedSignalCount'
> {
  if (!filters?.length) return {};
  return { filtersApplied: filters, originalSignalCount, returnedSignalCount };
}

/** Map bounded parent-Run read failures onto the public MCP error vocabulary. */
export function executionRunReadError(error: unknown): McpReadError {
  return isExecutionRunValidationError(error)
    ? readError('invalid-argument', 'Execution Run identity or pagination bounds are invalid.')
    : readError('execution-run-read-failed', 'Stored execution Run evidence could not be read.');
}

function isExecutionRunValidationError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = error.code;
  return typeof code === 'string' && EXECUTION_RUN_VALIDATION_CODES.has(code);
}
