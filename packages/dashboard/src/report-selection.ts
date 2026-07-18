/** The closed set of initial views a generated report may select. */
export interface ReportViewSelection {
  readonly view: 'change-impact';
  readonly runId?: string;
}

/**
 * Host-owned proof that an exact retained parent Run was resolved for report
 * composition. Never contributed by tools; reserved against external hooks.
 */
export interface ReportSelectionEvidence {
  readonly requestedRunId: string;
  readonly matched: boolean;
  readonly totalSteps: number;
  readonly includedSteps: number;
  readonly totalSessions: number;
  readonly includedSessions: number;
  readonly truncated: boolean;
}

const CHANGE_IMPACT_FRAGMENT = '#change-impact';
const CHANGE_IMPACT_VIEW = 'change-impact';
const REPORT_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Validate an untrusted report selection at the dashboard boundary.
 *
 * Invalid run identities are omitted while a valid Change Impact view remains
 * selectable. Unknown views are rejected entirely so callers cannot smuggle a
 * DOM id or arbitrary fragment through the report input.
 */
export function normalizeReportViewSelection(value: unknown): ReportViewSelection | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as {
    readonly view?: unknown;
    readonly runId?: unknown;
  };
  if (candidate.view !== CHANGE_IMPACT_VIEW) return undefined;
  if (candidate.runId === undefined) return { view: CHANGE_IMPACT_VIEW };
  if (typeof candidate.runId !== 'string' || !REPORT_RUN_ID.test(candidate.runId)) {
    return { view: CHANGE_IMPACT_VIEW };
  }
  return { view: CHANGE_IMPACT_VIEW, runId: candidate.runId };
}

/** Encode a validated selection as a local-report hash fragment. */
export function encodeReportViewSelection(selection: ReportViewSelection): string | undefined {
  const normalized = normalizeReportViewSelection(selection);
  if (normalized === undefined) return undefined;
  return normalized.runId === undefined
    ? CHANGE_IMPACT_FRAGMENT
    : `${CHANGE_IMPACT_FRAGMENT}/${encodeURIComponent(normalized.runId)}`;
}

/** Decode a local-report hash fragment without accepting arbitrary view or id text. */
export function decodeReportViewSelection(fragment: string): ReportViewSelection | undefined {
  if (fragment === CHANGE_IMPACT_FRAGMENT) return { view: CHANGE_IMPACT_VIEW };
  const prefix = `${CHANGE_IMPACT_FRAGMENT}/`;
  if (!fragment.startsWith(prefix)) return undefined;
  const encodedRunId = fragment.slice(prefix.length);
  // The accepted alphabet never needs escaping. Keep a bounded allowance here
  // so malformed percent-encoded input cannot make decoding unbounded.
  if (encodedRunId.length === 0 || encodedRunId.length > 384) return undefined;
  try {
    const runId = decodeURIComponent(encodedRunId);
    return REPORT_RUN_ID.test(runId) ? { view: CHANGE_IMPACT_VIEW, runId } : undefined;
  } catch {
    // @swallow-ok malformed percent-encoding is untrusted input and fails closed.
    return undefined;
  }
}
