/**
 * RunFooterHints — shared bottom-of-output hint strip used by every Ink
 * live view's done state.
 *
 * The format is fixed: a dim, two-space-indented line listing the
 * next-step flags a user is likely to reach for, separated by " | ". The
 * default run hints and their visibility policy live in `run-render-policy`;
 * callers pass custom hints only for intentionally custom surfaces while the
 * surrounding visual treatment stays consistent.
 *
 * The strip lives once, as the `viewFooterHints` view-model producer. The
 * Ink component renders it via `renderToInk`; the non-interactive path
 * renders the same view through `renderToText`, so the two cannot drift.
 * (The bold-substring tokenization is owned by the Ink interpreter's hint
 * renderer.)
 */

import { Box } from 'ink';
import React from 'react';

import { renderToInk } from './render-to-ink.js';

import type { ViewNode } from './view-model.js';

export interface RunFooterHint {
  /** Plain-text line to render. Substrings matching `bold` are bolded. */
  readonly text: string;
  /** Substrings within `text` to render bold. May be empty. */
  readonly bold?: readonly string[];
}

export interface RunFooterHintsProps {
  readonly hints: readonly RunFooterHint[];
}

/** The hint strip as a renderer-agnostic view-model node. */
export function viewFooterHints(hints: readonly RunFooterHint[]): ViewNode {
  return {
    kind: 'hints',
    items: hints.map((h) => (h.bold ? { text: h.text, bold: h.bold } : { text: h.text })),
  };
}

/** Ink view of {@link viewFooterHints}; renders nothing when there are no hints. */
export function RunFooterHints({ hints }: RunFooterHintsProps): React.ReactElement | null {
  if (hints.length === 0) return null;
  return <Box paddingTop={1}>{renderToInk(viewFooterHints(hints))}</Box>;
}
