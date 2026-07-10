/**
 * The structured error the MCP read ports return in the failure arm of their
 * `Result<T, E>` (ADR-0084). Ports return `Result` across domain boundaries,
 * including infrastructure failures. This is a plain DTO, not a thrown Error.
 */

import type { GraphReadError } from '@opensip-cli/graph/read';

export interface McpReadError {
  /** Machine-readable reason, e.g. `'ambiguous-symbol'`, `'not-found'`. */
  readonly code: string;
  /** Human-readable detail (already scrubbed/truncated where relevant). */
  readonly message: string;
  /** Optional bounded structured detail (refresh phase, duration, etc.). */
  readonly details?: Readonly<Record<string, string | number | boolean | undefined>>;
}

/** Cursor / paging error codes (MCP Graph Audit Phase 0). */
export type CursorErrorCode =
  | 'cursor-invalid'
  | 'cursor-project-mismatch'
  | 'cursor-stale'
  | 'cursor-query-mismatch'
  | 'response-too-large';

/** Build an {@link McpReadError}. */
export function readError(
  code: string,
  message: string,
  details?: Readonly<Record<string, string | number | boolean | undefined>>,
): McpReadError {
  return details === undefined ? { code, message } : { code, message, details };
}

/**
 * Map a graph/read Result error arm to McpReadError, preserving only fixed
 * code/message (no raw SQLite/graph throw text).
 */
export function fromGraphReadError(error: GraphReadError): McpReadError {
  switch (error.code) {
    case 'GRAPH.READ.CATALOG_IDENTITY': {
      return readError(error.code, 'Failed to read graph catalog identity');
    }
    case 'GRAPH.READ.CATALOG_GENERATION': {
      return readError(error.code, 'Failed to load graph catalog generation');
    }
    case 'GRAPH.READ.REBUILD_EMPTY': {
      return readError(error.code, 'Graph rebuild produced an empty catalog');
    }
    case 'GRAPH.READ.REBUILD_FAILED': {
      return readError(error.code, 'Graph rebuild failed due to an infrastructure error');
    }
    default: {
      return readError('graph-read-failed', 'Graph read failed.');
    }
  }
}

/** Fixed fallback for an unexpected throw at the MCP refresh boundary. */
export function unexpectedRefreshError(): McpReadError {
  return readError('refresh-failed', 'Graph refresh failed due to an infrastructure error.');
}
