/**
 * The structured error the MCP read ports return in the failure arm of their
 * `Result<T, E>` (ADR-0084). Ports return `Result` across domain boundaries;
 * `throw` is reserved for genuine infra failures (SQLite/Drizzle, the
 * `runGraph` child build). This is a plain DTO — not a thrown `Error`.
 */

import type { GraphReadError } from '@opensip-cli/graph/read';

export interface McpReadError {
  /** Machine-readable reason, e.g. `'ambiguous-symbol'`, `'not-found'`. */
  readonly code: string;
  /** Human-readable detail (already scrubbed/truncated where relevant). */
  readonly message: string;
}

/** Build an {@link McpReadError}. */
export function readError(code: string, message: string): McpReadError {
  return { code, message };
}

/**
 * Map a graph/read Result error arm to McpReadError, preserving only fixed
 * code/message (no raw SQLite/graph throw text).
 */
export function fromGraphReadError(error: GraphReadError): McpReadError {
  return {
    code: error.code,
    message: error.message,
  };
}
