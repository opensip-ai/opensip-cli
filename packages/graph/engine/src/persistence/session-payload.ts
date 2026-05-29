/**
 * Graph-owned session payload (audit 2026-05-29, session split).
 *
 * `contracts` stores per-session detail as an opaque JSON blob and holds
 * zero tool vocabulary. Graph owns its own payload shape here instead of
 * contorting signals into fitness-style "checks/findings" (the prior
 * `saveGraphSession` did exactly that — see DEC notes). Graph has no
 * per-session detail view today (its dashboard tab, Code Paths, is fed
 * by the separate graph catalog), so the payload is a compact native
 * signal summary; it can grow if a graph session detail view lands.
 */

/** Opaque-to-contracts detail blob written for every `graph` session. */
export interface GraphSessionPayload {
  readonly summary: {
    /** Total signals emitted by the run. */
    readonly total: number;
    /** Signals at info/pass severity. */
    readonly passed: number;
    /** Signals at failing severity. */
    readonly failed: number;
    /** Error-severity signal count. */
    readonly errors: number;
    /** Warning-severity signal count. */
    readonly warnings: number;
  };
}

/** Build the graph session payload from a CliOutput-style summary. */
export function buildGraphSessionPayload(summary: GraphSessionPayload['summary']): GraphSessionPayload {
  return { summary };
}
