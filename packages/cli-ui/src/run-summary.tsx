/**
 * RunSummary — shared one-line PASS/FAIL summary used by every Ink
 * live view in the suite (fitness, graph, sim).
 *
 * The format is fixed: `{P} Passed, {F} Failed ({E} Errors, {W} Warnings) | Duration {ms}`
 * with per-segment colors driven by the active theme. Counts are
 * rendered with semantically meaningful colors — `theme.error` for
 * nonzero errors, `theme.warning` for nonzero warnings, `theme.muted`
 * when zero — so the eye instantly anchors on the bad numbers without
 * counting digits.
 *
 * Every tool maps its own internal summary into the unified shape
 * accepted here. This is the single source of truth for the chrome
 * users see at the bottom of each tool's run; if you find yourself
 * tweaking the format in a tool-specific runner, refactor here
 * instead.
 */

import { Box, Text } from 'ink';
import React from 'react';

import { useTheme } from './theme.js';

export interface RunSummaryProps {
  readonly passed: number;
  readonly failed: number;
  readonly errors: number;
  readonly warnings: number;
  readonly durationMs: number;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function RunSummary({ passed, failed, errors, warnings, durationMs }: RunSummaryProps): React.ReactElement {
  const theme = useTheme();
  return (
    <Box paddingTop={1}>
      <Text>
        <Text color={theme.success}>{passed} Passed</Text>
        , <Text color={failed > 0 ? theme.error : theme.muted}>{failed} Failed</Text>
        {' ('}
        <Text color={errors > 0 ? theme.error : theme.muted}>{errors} Errors</Text>
        , <Text color={warnings > 0 ? theme.warning : theme.muted}>{warnings} Warnings</Text>
        {') '}
        <Text dimColor>|</Text>
        {' Duration '}
        <Text color={theme.info}>{formatDuration(durationMs)}</Text>
      </Text>
    </Box>
  );
}
