/**
 * Persisted run outcome vocabulary (ADR-0060, Phase 6).
 *
 * Distinguishes credible scan outcomes (`passed` / `failed` / `degraded`) from
 * setup failures (`error`) so dashboards and session replay do not treat incomplete
 * runs as green score-100 passes.
 */

/** Canonical persisted run outcome for a tool session row. */
export type ToolRunOutcome = 'passed' | 'failed' | 'degraded' | 'error';

/** Inputs for stamping a new session row from a completed run. */
export interface DeriveRunOutcomeInput {
  readonly passed: boolean;
  /** When set, overrides the passed/failed inference (e.g. strict degraded). */
  readonly explicit?: ToolRunOutcome;
}

/**
 * Derive the outcome to persist for a completed credible scan.
 * Command-error runs should pass `explicit: 'error'` (or omit persistence).
 */
export function deriveRunOutcome(input: DeriveRunOutcomeInput): ToolRunOutcome {
  if (input.explicit !== undefined) return input.explicit;
  return input.passed ? 'passed' : 'failed';
}

/** Legacy sessions without `runOutcome`: infer passed/failed only — never degraded/error. */
export function inferStoredRunOutcome(session: {
  readonly passed: boolean;
  readonly runOutcome?: ToolRunOutcome;
}): ToolRunOutcome {
  if (session.runOutcome !== undefined) return session.runOutcome;
  return session.passed ? 'passed' : 'failed';
}
