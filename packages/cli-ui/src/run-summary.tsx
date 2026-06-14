/**
 * RunSummary — shared one-line PASS/FAIL summary used by every Ink live
 * view in the suite (fitness, graph, sim).
 *
 * The format is fixed: `{PASS|FAIL}  ({E} Errors, {W} Warnings) | Duration {dur}`
 * (ADR-0035). The leading token is the run's single verdict
 * (`envelope.verdict.passed`) — the same value that drives the exit code — so
 * the headline answers "did this run pass?" directly; the error/warning counts
 * are the detail. A clean run reads `PASS  (0 Errors, 0 Warnings)` (no more
 * misleading `0 Passed, 0 Failed`). Per-unit pass/fail lives in the table below.
 * Colors are theme-driven (success/error for the verdict; error/warning for
 * nonzero counts, muted when zero).
 *
 * The format lives once, as the `viewRunSummary` view-model producer. The
 * Ink component is a thin wrapper that renders that view; the
 * non-interactive (piped/CI) path renders the same view through
 * `renderToText`, so the two cannot drift. (Previously the plain-text form
 * was hand-retyped in graph's `writeRunSummaryPlain`.)
 */

import { Box } from 'ink';
import React from 'react';

import { formatDuration } from './format-duration.js';
import { renderToInk } from './render-to-ink.js';
import { useRunDuration } from './run-timing-provider.js';
import { line, type Span, type ViewNode } from './view-model.js';

export interface RunSummaryProps {
  /** The run's single verdict (ADR-0035) — the headline PASS/FAIL token. */
  readonly passed: boolean;
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
  errors,
  warnings,
  durationMs = 0,
}: RunSummaryProps): ViewNode {
  const spans: Span[] = [
    { text: passed ? 'PASS' : 'FAIL', tone: passed ? 'success' : 'error' },
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
  // When durationMs omitted, read from the RunTimingProvider (host timer).
  // This makes the displayed duration match the value that will be (or was)
  // recorded to StoredSession via the host `runSession.record` seam.
  const resolvedDuration = props.durationMs ?? useRunDuration();
  const viewProps: RunSummaryProps = { ...props, durationMs: resolvedDuration };
  return (
    <Box paddingTop={1} paddingLeft={2}>
      {renderToInk(viewRunSummary(viewProps))}
    </Box>
  );
}
