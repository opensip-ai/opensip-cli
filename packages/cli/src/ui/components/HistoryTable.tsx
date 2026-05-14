/**
 * HistoryTable component — renders run history sessions.
 */

import { Text, Box } from 'ink';
import React from 'react';

import { useTheme } from '../theme.js';

import type { StoredSession } from '@opensip-tools/cli-shared';

export interface HistoryTableProps {
  readonly sessions: readonly StoredSession[];
}

function scoreColor(score: number, theme: { scoreHigh: string; scoreMid: string; scoreLow: string }): string {
  if (score >= 90) return theme.scoreHigh;
  if (score >= 70) return theme.scoreMid;
  return theme.scoreLow;
}

export function HistoryTable({ sessions }: HistoryTableProps): React.ReactElement {
  const theme = useTheme();

  if (sessions.length === 0) {
    return (
      <Box paddingLeft={2}>
        <Text dimColor>No sessions recorded yet. Run opensip-tools fit to generate data.</Text>
      </Box>
    );
  }

  // Show at most 20 entries, matching current behavior
  const visible = sessions.slice(0, 20);

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>Run History</Text>
        {' '}
        <Text dimColor>({sessions.length} sessions)</Text>
      </Text>
      <Text> </Text>
      {visible.map((s) => {
        const date = new Date(s.timestamp).toLocaleString();
        const duration = `${(s.durationMs / 1000).toFixed(1)}s`;
        return (
          <Text key={s.id}>
            {'  '}
            <Text dimColor>{date}</Text>
            {'  '}
            <Text color={scoreColor(s.score, theme)}>{s.score}%</Text>
            {'  '}
            <Text color={s.passed ? theme.statusPass : theme.statusFail}>
              {s.passed ? 'PASS' : 'FAIL'}
            </Text>
            {'  '}
            {s.summary.passed}/{s.summary.total} checks
            {s.recipe && <Text dimColor> ({s.recipe})</Text>}
            {'  '}
            <Text dimColor>{duration}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
