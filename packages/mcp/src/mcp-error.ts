/**
 * The structured error the MCP read ports return in the failure arm of their
 * `Result<T, E>` (ADR-0084). Ports return `Result` across domain boundaries,
 * including infrastructure failures. This is a plain DTO, not a thrown Error.
 */

import { formatUnknownErrorMessage } from '@opensip-cli/core';

import type { GraphReadError } from '@opensip-cli/graph/read';

const MAX_ERROR_MESSAGE = 512;
const DEFAULT_ERROR_MESSAGE = 'Infrastructure error.';
const STACK_LINE = /^\s*at(?:\s|$)/u;
const PATH_BOUNDARY = String.raw`(^|[\s([{:;,='"])`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactLiteralPath(message: string, path: string | undefined): string {
  if (path === undefined || path.length === 0) return message;
  const variants = new Set([path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')]);
  let output = message;
  for (const variant of variants) {
    if (variant.length > 0) {
      output = output.replace(
        new RegExp(`${escapeRegExp(variant)}(?:[\\\\/][^\\s"'<>]*)?`, 'giu'),
        '<project>',
      );
    }
  }
  return output;
}

function redactAbsolutePaths(message: string): string {
  const unc = new RegExp(
    `${PATH_BOUNDARY}(\\\\\\\\[^\\s\\\\/]+[\\\\/][^\\s\\\\/]+(?:[\\\\/][^\\s"'<>]*)?)`,
    'giu',
  );
  const windows = new RegExp(`${PATH_BOUNDARY}([A-Z]:[\\\\/][^\\s"'<>]*)`, 'giu');
  const posix = new RegExp(`${PATH_BOUNDARY}((?:file:\\/\\/)?\\/[^\\s"'<>]*)`, 'giu');
  return message.replace(unc, '$1<path>').replace(windows, '$1<path>').replace(posix, '$1<path>');
}

/** Scrub an unknown boundary error into an idempotent, bounded MCP-safe message. */
export function sanitizeMcpErrorMessage(
  error: unknown,
  options?: { readonly projectRoot?: string; readonly fallback?: string },
): string {
  try {
    const primary = scrubErrorText(formatUnknownErrorMessage(error), options?.projectRoot);
    const fallback = scrubErrorText(
      options?.fallback ?? DEFAULT_ERROR_MESSAGE,
      options?.projectRoot,
    );
    return [...(primary || fallback || DEFAULT_ERROR_MESSAGE)].slice(0, MAX_ERROR_MESSAGE).join('');
  } catch {
    try {
      const fallback = scrubErrorText(
        options?.fallback ?? DEFAULT_ERROR_MESSAGE,
        options?.projectRoot,
      );
      return [...(fallback || DEFAULT_ERROR_MESSAGE)].slice(0, MAX_ERROR_MESSAGE).join('');
    } catch {
      return DEFAULT_ERROR_MESSAGE;
    }
  }
}

function scrubErrorText(raw: string, projectRoot: string | undefined): string {
  const withoutStack = raw
    .split(/\r?\n/u)
    .filter((line) => !STACK_LINE.test(line))
    .join(' ');
  const controlFree = withoutStack.replace(/\p{Cc}/gu, ' ');
  return redactAbsolutePaths(redactLiteralPath(controlFree, projectRoot))
    .replace(/\s+/gu, ' ')
    .trim();
}

export interface McpReadError {
  /** Machine-readable reason, e.g. `'ambiguous-symbol'`, `'not-found'`. */
  readonly code: string;
  /** Human-readable detail (already scrubbed/truncated where relevant). */
  readonly message: string;
  /** Optional bounded structured detail (refresh phase, duration, etc.). */
  readonly details?: Readonly<Record<string, string | number | boolean | undefined>>;
}

/** Build an {@link McpReadError}. */
export function readError(
  code: string,
  message: string,
  details?: Readonly<Record<string, string | number | boolean | undefined>>,
): McpReadError {
  const safeMessage = sanitizeMcpErrorMessage(message);
  if (details === undefined) return { code, message: safeMessage };
  const safeDetails = Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      typeof value === 'string' ? sanitizeMcpErrorMessage(value) : value,
    ]),
  );
  return { code, message: safeMessage, details: safeDetails };
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
    case 'GRAPH.READ.CURSOR_INVALID': {
      return readError('cursor-invalid', 'Cursor continuation anchor is invalid.');
    }
    case 'GRAPH.READ.IMPACT_FILES_CAP':
    case 'GRAPH.READ.TEST_SELECTION_FILES_CAP': {
      return readError('input-cap-exceeded', 'The request exceeds a bounded graph-read cap.');
    }
    case 'GRAPH.READ.IMPACT_FILE_INVALID':
    case 'GRAPH.READ.ENTITY_ID_INVALID':
    case 'GRAPH.READ.TEST_SELECTION_FILE_INVALID': {
      return readError('invalid-input', 'The graph-read input is invalid.');
    }
    case 'GRAPH.READ.IMPACT_CANCELLED':
    case 'GRAPH.READ.TEST_SELECTION_CANCELLED': {
      return readError('cancelled', 'The graph read was cancelled.');
    }
    case 'GRAPH.READ.IMPACT_FAILED': {
      return readError('impact-read-failed', 'Graph impact could not be projected safely.');
    }
    case 'GRAPH.READ.ENTITY_MALFORMED':
    case 'GRAPH.READ.ENTITY_FAILED': {
      return readError('entity-read-failed', 'Graph entity detail could not be projected safely.');
    }
    case 'GRAPH.READ.TEST_SELECTION_FAILED': {
      return readError('test-selection-failed', 'Static test selection could not be projected.');
    }
    default: {
      return readError('graph-read-failed', 'Graph read failed.');
    }
  }
}

/** Fixed fallback for an unexpected throw at the MCP refresh boundary. */
export function unexpectedRefreshError(durationMs?: number): McpReadError {
  return readError('graph-refresh-failed', 'Graph refresh failed due to an infrastructure error.', {
    failedPhase: 'handler',
    outcome: 'failed',
    ...(durationMs === undefined ? {} : { durationMs }),
  });
}
