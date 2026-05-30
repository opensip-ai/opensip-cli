/**
 * Graph-owned session payload (audit 2026-05-29, session split; extended
 * 2026-05-29 to carry per-rule detail for the Code Paths session view).
 *
 * `contracts` stores per-session detail as an opaque JSON blob and holds
 * zero tool vocabulary. Graph owns its own payload shape here. The split
 * refactor (8a854a8) originally wrote summary-only because "graph has no
 * per-session detail view today"; that premise no longer holds — the
 * Code Paths → Sessions subtab now renders a per-rule detail panel, so
 * the payload carries the same rule-grouped detail graph already computes
 * for its JSON/SARIF surfaces (see `buildCliOutput` in render/json.ts).
 *
 * The detail shape (`summary` + `checks[]` of rule-grouped findings) is
 * the dashboard's structural session-detail contract, consumed by the
 * shared `renderDetail` in @opensip-tools/dashboard. It is NOT fitness
 * vocabulary leaking back into graph: graph independently produces this
 * exact shape from `Signal[]` via `buildCliOutput`. Reusing the contracts
 * `CheckOutput`/`FindingOutput` types keeps the two producers converged on
 * one renderer without contracts gaining any domain vocabulary (the blob
 * stays opaque to the persistence layer).
 */

import type { CheckOutput, CliOutput } from '@opensip-tools/contracts';

/**
 * Opaque-to-contracts detail blob written for every `graph` session.
 *
 * `checks` is graph's rule-grouped detail: one entry per `ruleId` that
 * emitted ≥1 signal, each carrying its findings. The dashboard's shared
 * session-detail renderer reads `summary` and `checks` structurally.
 */
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
  /**
   * Per-rule detail, one entry per `ruleId`. Mirrors the structural shape
   * the dashboard's `renderDetail` consumes (`checkSlug`/`passed`/
   * `findings[]`). Sourced directly from `CliOutput.checks`, which graph
   * already builds by grouping `Signal[]` by `ruleId`.
   */
  readonly checks: readonly CheckOutput[];
}

/**
 * Build the graph session payload from the run's {@link CliOutput}.
 *
 * The full `CliOutput` is available at the save site (`saveGraphSession`
 * in cli/graph.ts) — it is produced by `buildCliOutput(signals, 'graph')`,
 * which already groups signals by `ruleId` into `checks[]`. This builder
 * selects the slice the dashboard renders.
 *
 * Persists the full detail: every rule's findings are kept (no cap), so
 * the dashboard's per-rule view and its finding counts stay faithful to
 * the run. Graph runs can emit hundreds of warning-severity signals, but
 * the datastore is a rebuildable local cache, so blob size is an
 * acceptable trade for complete detail. If volume ever bites, capping
 * per rule (with `violationCount` kept at the true count) is a clean
 * follow-up.
 *
 * @param output - the run's CliOutput (summary + rule-grouped checks).
 * @returns the opaque detail blob persisted for this graph session.
 */
export function buildGraphSessionPayload(output: CliOutput): GraphSessionPayload {
  return { summary: output.summary, checks: output.checks };
}
