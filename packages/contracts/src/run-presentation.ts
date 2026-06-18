/**
 * RunPresentation — the single render-only adjunct to a run's SignalEnvelope.
 *
 * This is the replacement for the three near-identical `*DoneResult` interfaces
 * (`FitDoneResult` / `SimDoneResult` / `GraphDoneResult` in `command-results.ts`):
 * each of those wraps a {@link SignalEnvelope} plus `verboseDetail?` and (graph
 * only) a one-line resolution caveat. `RunPresentation` carries exactly that —
 * the envelope (the findings currency, ADR-0011), the optional verbose body
 * (ADR-0021), an optional host-owned display duration (ADR-0051), and the one
 * tool-specific display field (graph's resolution caveat) as muted banners.
 *
 * It is render-only. It is NEVER serialized into `--json` — `CommandOutcome.envelope`
 * stays the machine currency (ADR-0011). The host hands it to `cli.render(...)`
 * exactly where the tools used to hand a `*DoneResult`; `resultToView` maps it
 * to a view-model through `presentationToView` (cli-side).
 *
 * It imports ONLY `SignalEnvelope` and `VerboseDetail` from contracts itself —
 * no UI types, no tool types. `VerboseDetail` comes from `./verbose-detail.js`
 * (its currency home), NOT `./command-results.js`, so this module does not form a
 * `command-results → run-presentation → command-results` cycle (no-circular).
 * dependency-cruiser locks this module to a core-only edge (the
 * `contracts-imports-core-only` rule, which RP-0 extends to forbid a `cli-ui`
 * edge), so it can never silently start importing UI primitives.
 */

import type { SignalEnvelope } from './signal-envelope.js';
import type { VerboseDetail } from './verbose-detail.js';

/**
 * The render-only adjunct to a run's {@link SignalEnvelope} — the single
 * `cli.render(...)` argument every analysis run command hands the host
 * (envelope-first-presentation plan; replaces the three `*DoneResult` variants).
 * Carries the envelope (findings currency, ADR-0011), the optional verbose body
 * (ADR-0021), an optional host-owned display duration (ADR-0051), and graph's
 * resolution-caveat banners. Never serialized into `--json`.
 */
export interface RunPresentation {
  /**
   * Render discriminator. `resultToView` switches on this literal to route a
   * `RunPresentation` through `presentationToView` (the single render path).
   */
  readonly type: 'run-presentation';
  /** The tool that produced this run (e.g. `'fitness'`, `'simulation'`, `'graph'`). */
  readonly tool: string;
  /**
   * The run's signal envelope (ADR-0011) — REQUIRED. The findings currency from
   * which the rendered per-unit table, summary line, and verdict are all derived
   * (via `envelopeToTableView` → `formatSignalTableRows`). This is the ONLY
   * machine-facing field; it is never re-serialized FROM the presentation (the
   * `--json` path reads `CommandOutcome.envelope` directly).
   */
  readonly envelope: SignalEnvelope;
  /**
   * Verbose detail body (ADR-0021), present only on `--verbose` runs. Rendered
   * by the shared `resultToView` seam so the body is identical in a TTY and a
   * pipe. Tools populate the `findings` kind (fit/sim) or the `lines` kind
   * (graph's catalog/findings/entry-point dump).
   */
  readonly verboseDetail?: VerboseDetail;
  /**
   * Display-only run wall-clock for the summary line. Host-owned (ADR-0051): the
   * host stamps the session row's `durationMs` from its single `RunTimer`; tools
   * never compute it for the generic session row. This is NOT dead metadata —
   * `presentationToView` forwards it into `envelopeToTableView` as the explicit
   * `durationOverride`, so the host-owned wall-clock (not the envelope unit-sum,
   * which is `0` for tools whose units carry no per-unit duration, e.g. graph)
   * drives the rendered Duration.
   */
  readonly durationMs?: number;
  /**
   * The ONLY tool-specific display field: caveat lines rendered as muted text
   * above the summary (graph's fast-tier resolution caveat). Each entry is one
   * muted line. fit/sim leave this undefined.
   *
   * There is intentionally NO `footerHints` field: the non-verbose footer hint
   * is a single shared constant (`VERBOSE_DETAIL_HINT`) emitted by the shared
   * render seam, not a per-tool display field.
   */
  readonly banners?: readonly string[];
}
