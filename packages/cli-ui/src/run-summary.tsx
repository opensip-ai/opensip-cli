/**
 * RunSummary — shared one-line PASS/FAIL summary used by every Ink live
 * view in the suite (fitness, graph, sim).
 *
 * The format is fixed: `{P} Passed, {F} Failed ({E} Errors, {W} Warnings) | Duration {dur}`
 * with per-segment colors driven by the active theme. Counts are rendered
 * with semantically meaningful colors — error for nonzero errors, warning
 * for nonzero warnings, muted when zero — so the eye anchors on the bad
 * numbers without counting digits.
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
import { line, type Span, type ViewNode } from './view-model.js';

export interface RunSummaryProps {
  readonly passed: number;
  readonly failed: number;
  readonly errors: number;
  readonly warnings: number;
  readonly durationMs: number;
}

/**
 * The canonical summary line as a renderer-agnostic view-model node. Span
 * text concatenates to exactly:
 *   `{P} Passed, {F} Failed ({E} Errors, {W} Warnings) | Duration {dur}`
 */
export function viewRunSummary({ passed, failed, errors, warnings, durationMs }: RunSummaryProps): ViewNode {
  const spans: Span[] = [
    { text: `${passed} Passed`, tone: 'success' },
    { text: ', ' },
    { text: `${failed} Failed`, tone: failed > 0 ? 'error' : 'muted' },
    { text: ' (' },
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
  return <Box paddingTop={1} paddingLeft={2}>{renderToInk(viewRunSummary(props))}</Box>;
}
