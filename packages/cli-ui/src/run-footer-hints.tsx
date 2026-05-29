/**
 * RunFooterHints — shared bottom-of-output hint strip used by every
 * Ink live view's done state.
 *
 * The format is fixed: a dim, two-space-indented line listing the
 * next-step flags a user is likely to reach for, separated by " | ".
 * Each tool supplies its own list of hints so the strip can name
 * tool-specific flags (e.g. `--verbose`, `--report-to <url>`) while
 * the surrounding visual treatment stays consistent across tools.
 *
 * Each hint specifies which substring(s) within its text should render
 * bold (the flag/command being highlighted). Everything else renders
 * dim. Keeping the hints data-driven means a tool can add or remove
 * hints without touching this component's layout code.
 */

import { Box, Text } from 'ink';
import React from 'react';

export interface RunFooterHint {
  /** Plain-text line to render. Substrings matching `bold` are bolded. */
  readonly text: string;
  /** Substrings within `text` to render bold. May be empty. */
  readonly bold?: readonly string[];
}

export interface RunFooterHintsProps {
  readonly hints: readonly RunFooterHint[];
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

function renderHint(hint: RunFooterHint, key: number): React.ReactElement {
  const bolds = hint.bold ?? [];
  if (bolds.length === 0) return <Text key={key}>{hint.text}</Text>;
  // Build an alternation regex over the bold substrings (longest first
  // so a longer match takes precedence over a shorter prefix). `split`
  // with a capturing group preserves the matched chunks alongside the
  // non-matching ones, giving us the tokenized form we need.
  const escaped = [...bolds]
    .sort((a, b) => b.length - a.length)
    .map((s) => s.replaceAll(REGEX_META, String.raw`\$&`));
  const parts = hint.text.split(new RegExp(`(${escaped.join('|')})`));
  const boldSet = new Set<string>(bolds);
  return (
    <Text key={key}>
      {parts.map((p, i) =>
        boldSet.has(p) ? <Text key={i} bold>{p}</Text> : <Text key={i}>{p}</Text>,
      )}
    </Text>
  );
}

export function RunFooterHints({ hints }: RunFooterHintsProps): React.ReactElement | null {
  if (hints.length === 0) return null;
  return (
    <Box paddingTop={1} paddingLeft={2}>
      <Text dimColor>
        {hints.map((hint, i) => (
          <Text key={i}>
            {i > 0 ? ' | ' : ''}
            {renderHint(hint, i)}
          </Text>
        ))}
      </Text>
    </Box>
  );
}
