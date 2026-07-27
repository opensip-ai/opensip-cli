/**
 * The structured error the MCP read ports return in the failure arm of their
 * `Result<T, E>` (ADR-0084). Ports return `Result` across domain boundaries,
 * including infrastructure failures. This is a plain DTO, not a thrown Error.
 */

import { formatUnknownErrorMessage } from '@opensip-cli/core';

import type { GraphReadError } from '@opensip-cli/graph/read';
import type { SessionReplayReason } from '@opensip-cli/session-store';

const MAX_ERROR_MESSAGE = 512;
const DEFAULT_ERROR_MESSAGE = 'Infrastructure error.';
const STACK_LINE = /^\s*at(?:\s|$)/u;

function boundaryMessage(error: unknown): string {
  if (typeof error !== 'object' || error === null) return formatUnknownErrorMessage(error);
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string'
    ) {
      return '';
    }
  } catch {
    return '';
  }
  return formatUnknownErrorMessage(error);
}
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
    const primary = scrubErrorText(boundaryMessage(error), options?.projectRoot);
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

/**
 * The closed MCP wire vocabulary (Plan 01 ruling `result-reason-code-scope`).
 *
 * These strings are the agent-facing contract, so they are enumerated rather than left as
 * `string`: an untyped reason field is what lets two handlers drift onto near-synonyms with
 * nothing to catch it. Lowercase-kebab throughout, deliberately unmistakable for a registered
 * `OWNER.DOMAIN.CONDITION` error code — a consumer must be able to tell at a glance which
 * contract it is holding, because only one of the two carries axes and an operator action.
 *
 * `fromGraphReadError` maps graph's `GraphReadReason` onto this set explicitly. It does not
 * forward graph reasons through, which would make graph's internal vocabulary part of this
 * public surface.
 */
export type McpReadReason =
  | 'ambiguous-latest'
  | 'baseline-delta-unavailable'
  | 'baseline-error'
  | 'blast-unavailable'
  | 'cancelled'
  | 'catalog-churn'
  | 'catalog-generation'
  | 'catalog-identity'
  | 'catalog-identity-invalid'
  | 'catalog-identity-mismatch'
  | 'catalog-sync-failed'
  | 'catalog-unreadable'
  | 'context-run-foreign-project'
  | 'context-run-invalid-manifest'
  | 'context-run-read-failed'
  | 'context-run-unsupported-version'
  | 'context-run-wrong-kind'
  | 'cursor-invalid'
  | 'cursor-project-mismatch'
  | 'cursor-query-mismatch'
  | 'cursor-stale'
  | 'decode-error'
  | 'entity-not-found'
  | 'entity-read-failed'
  | 'execution-run-read-failed'
  | 'failing-verdict-without-signals'
  | 'graph-catalog-unavailable'
  | 'graph-query-failed'
  | 'graph-read-failed'
  | 'graph-refresh-failed'
  | 'graph-source-role-failed'
  | 'impact-read-failed'
  | 'input-cap-exceeded'
  | 'invalid-argument'
  | 'invalid-context-files'
  | 'invalid-input'
  | 'invalid-query'
  | 'inventory-read-failed'
  | 'legacy-baseline-payload'
  | 'mcp-mutation-disabled'
  | 'missing-baseline'
  | 'missing-envelope'
  | 'missing-fingerprint'
  | 'missing-suite-evidence'
  | 'not-found'
  | 'rebuild-empty'
  | 'rebuild-configuration'
  | 'rebuild-failed'
  | 'repair-child-failed'
  | 'repair-entrypoint-unavailable'
  | 'repair-output-invalid'
  | 'repair-output-too-large'
  | 'repair-spawn-failed'
  | 'repair-timeout'
  | 'replay-unavailable'
  | 'response-too-large'
  | 'runtime-wiring-failed'
  | 'step-fault'
  | 'symbol-not-found'
  | 'unknown-tool'
  | 'wrong-tool'
  | 'test-selection-failed';

export interface McpReadError {
  /** Machine-readable reason, e.g. `'symbol-not-found'`, `'not-found'`. */
  readonly code: McpReadReason;
  /** Human-readable detail (already scrubbed/truncated where relevant). */
  readonly message: string;
  /** Optional bounded structured detail (refresh phase, duration, etc.). */
  readonly details?: Readonly<Record<string, string | number | boolean | undefined>>;
}

/** Build an {@link McpReadError}. */
export function readError(
  code: McpReadReason,
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
    case 'catalog-identity': {
      return readError('catalog-identity', 'Failed to read graph catalog identity');
    }
    case 'catalog-generation': {
      return readError('catalog-generation', 'Failed to load graph catalog generation');
    }
    case 'rebuild-empty': {
      return readError('rebuild-empty', 'Graph rebuild produced an empty catalog');
    }
    case 'rebuild-cancelled': {
      return readError('cancelled', 'Graph rebuild was cancelled');
    }
    case 'rebuild-configuration': {
      return readError('rebuild-configuration', 'Graph rebuild configuration is invalid');
    }
    case 'rebuild-failed': {
      return readError('rebuild-failed', 'Graph rebuild failed due to an infrastructure error');
    }
    case 'cursor-invalid': {
      return readError('cursor-invalid', 'Cursor continuation anchor is invalid.');
    }
    case 'impact-files-cap':
    case 'test-selection-files-cap': {
      return readError('input-cap-exceeded', 'The request exceeds a bounded graph-read cap.');
    }
    case 'impact-file-invalid':
    case 'entity-id-invalid':
    case 'test-selection-file-invalid': {
      return readError('invalid-input', 'The graph-read input is invalid.');
    }
    case 'impact-cancelled':
    case 'test-selection-cancelled': {
      return readError('cancelled', 'The graph read was cancelled.');
    }
    case 'impact-failed': {
      return readError('impact-read-failed', 'Graph impact could not be projected safely.');
    }
    case 'entity-malformed':
    case 'entity-failed': {
      return readError('entity-read-failed', 'Graph entity detail could not be projected safely.');
    }
    case 'test-selection-failed': {
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

/**
 * Map a session-store replay/resolve reason onto the MCP wire.
 *
 * Explicit, like {@link fromGraphReadError}, rather than forwarding the upstream reason
 * through: forwarding makes another package's internal vocabulary part of this public surface,
 * so a rename there silently becomes a wire break here. The members happen to coincide today —
 * that is what makes the forwarding version look harmless, and exactly why it is not.
 */
export function fromSessionReason(reason: SessionReplayReason, detail: string): McpReadError {
  switch (reason) {
    case 'not-found': {
      return readError('not-found', detail);
    }
    case 'wrong-tool': {
      return readError('wrong-tool', detail);
    }
    case 'ambiguous-latest': {
      return readError('ambiguous-latest', detail);
    }
    case 'decode-error': {
      return readError('decode-error', detail);
    }
    case 'replay-unavailable': {
      return readError('replay-unavailable', detail);
    }
  }
}
