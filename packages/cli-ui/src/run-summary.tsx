/**
 * RunSummary — shared one-line PASS/FAIL/FAULT summary used by every Ink live
 * view in the suite (fitness, graph, sim).
 *
 * The format is fixed: `{PASS|FAIL|FAULT}  ({E} Errors, {W} Warnings) | Duration
 * {dur}` (ADR-0035). The leading token is the run's single 3-way outcome — a
 * `FAULT` (a RUNTIME error: a unit threw/timed-out) is distinct from a `FAIL`
 * (findings crossed the gate), since a fault means the result is UNKNOWN, not
 * that the code failed. The error/warning counts stay the detail: on a `FAULT`
 * they are real (the units that DID run), because a run-LEVEL fault — where fit
 * itself faulted and produced no trustworthy findings — never reaches this
 * envelope headline at all (ADR-0060: it is a command-error before the
 * envelope). A clean run reads `PASS  (0 Errors, 0 Warnings)`. Per-unit
 * pass/fail lives in the table/bullets below. Colors are theme-driven (success/
 * error/warning for the verdict token; error/warning for nonzero counts).
 *
 * The format lives once, as the `viewRunSummary` view-model producer. The
 * Ink component is a thin wrapper that renders that view; the
 * non-interactive (piped/CI) path renders the same view through
 * `renderToText`, so the two cannot drift. (Previously the plain-text form
 * was hand-retyped in graph's `writeRunSummaryPlain`.)
 */

import { Box } from 'ink';
import React from 'react';

import { formatDuration } from '@opensip-cli/format';
import { renderToInk } from './render-to-ink.js';
import { useRunDuration } from './run-timing-provider.js';
import { line, type Span, type ViewNode } from './view-model.js';

export interface RunSummaryProps {
  /** The run's single verdict (ADR-0035) — the headline PASS/FAIL token. */
  readonly passed: boolean;
  /**
   * When true the run FAULTED (a runtime error) — the headline reads `FAULT`
   * instead of `FAIL`, since the result is unknown rather than a findings
   * failure. Optional/forward-compat: a caller that omits it keeps the binary
   * PASS/FAIL. A faulted run always has `passed: false`.
   */
  readonly faulted?: boolean;
  readonly errors: number;
  readonly warnings: number;
  /**
   * Explicit duration. When omitted, the component reads from the nearest
   * `RunTimingProvider` (host-owned run timer). This is the preferred path
   * after the host-owned-run-timing migration.
   *
   * Kept optional for compat during Phases 3-5 (tools still passing the old
   * per-tool numbers); once tools omit it the provider supplies the value
   * that matches the persisted StoredSession.
   */
  readonly durationMs?: number;
}

/**
 * The canonical summary line as a renderer-agnostic view-model node. Span
 * text concatenates to exactly:
 *   `{PASS|FAIL}  ({E} Errors, {W} Warnings) | Duration {dur}`
 */
export function viewRunSummary({

  passed,
  faulted = false,
  errors,
  warnings,
  durationMs = 0,
}: RunSummaryProps): ViewNode {
  // A fault dominates: `FAULT` (warning tone — "result unknown") over PASS/FAIL.
  const verdict: Span = faulted
    ? { text: 'FAULT', tone: 'warning' }
    : { text: passed ? 'PASS' : 'FAIL', tone: passed ? 'success' : 'error' };
  const spans: Span[] = [
    verdict,
    { text: '  (' },
    { text: `${errors} Errors`, tone: errors > 0 ? 'error' : 'muted' },
    { text: ', ' },
    { text: `${warnings} Warnings`, tone: warnings > 0 ? 'warning' : 'muted' },
    { text: ') ' },
    { text: '|', dim: true },
    { text: ' Duration ' },
    { text: formatDuration(durationMs), tone: 'info' },
  ];
  return line(spans);
}

/** Ink view of {@link viewRunSummary}. Indented to `paddingLeft={2}` so the
 *  live summary line aligns with the run header + footer hints (both also at 2)
 *  instead of sitting flush-left against the indented rest of the output. */
export function RunSummary(props: RunSummaryProps): React.ReactElement {
  // When durationMs omitted, read from the RunTimingProvider (host RunTimer).
  // ADR-0144 live vs final: the final summary must use the same host-stamped
  // duration that is persisted as StoredSession.durationMs — never a second
  // wall-clock sample after tool return. Live spinners may still tick separately.
  const resolvedDuration = props.durationMs ?? useRunDuration();
  const viewProps: RunSummaryProps = { ...props, durationMs: resolvedDuration };
  return (
    <Box paddingTop={1} paddingLeft={2}>
      {renderToInk(viewRunSummary(viewProps))}
    </Box>
  );
}
