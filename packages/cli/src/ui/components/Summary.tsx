/**
 * Summary component — single-line fitness check summary.
 * Example: 120 Passed, 10 Failed (423 Errors, 227 Warnings) | Duration 8.1s
 */

import { Text, Box } from 'ink';
import React from 'react';

import { useTheme } from '../theme.js';

export interface SummaryProps {
  readonly passed: number;
  readonly failed: number;
  readonly totalErrors: number;
  readonly totalWarnings: number;
  readonly totalIgnored: number;
  readonly durationMs: number;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function Summary(props: SummaryProps): React.ReactElement {
  const theme = useTheme();
  const { passed, failed, totalErrors, totalWarnings, durationMs } = props;

  return (
    <Box paddingTop={1}>
      <Text>
        <Text color={theme.success}>{passed} Passed</Text>
        , <Text color={failed > 0 ? theme.error : theme.muted}>{failed} Failed</Text>
        {' ('}
        <Text color={totalErrors > 0 ? theme.error : theme.muted}>{totalErrors} Errors</Text>
        , <Text color={totalWarnings > 0 ? theme.warning : theme.muted}>{totalWarnings} Warnings</Text>
        {') '}
        <Text dimColor>|</Text>
        {' Duration '}
        <Text color={theme.info}>{formatDuration(durationMs)}</Text>
      </Text>
    </Box>
  );
}
