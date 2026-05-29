/**
 * HistoryTable component — renders run history sessions.
 */

import { useTheme } from '@opensip-tools/cli-ui';
import { Text, Box } from 'ink';
import React from 'react';


import type { StoredSession } from '@opensip-tools/contracts';

export interface HistoryTableProps {
  readonly sessions: readonly StoredSession[];
}

function scoreColor(score: number, theme: { scoreHigh: string; scoreMid: string; scoreLow: string }): string {
  if (score >= 90) return theme.scoreHigh;
  if (score >= 70) return theme.scoreMid;
  return theme.scoreLow;
}

/**
 * Extract a generic passed/total ratio from a session's opaque payload,
 * if the tool wrote one. The history view is presentation: it reads the
 * tool-owned payload structurally (the same model the dashboard uses)
 * rather than `contracts` carrying a fitness-shaped summary. Returns null
 * for sessions whose payload has no summary so the column is omitted.
 */
function payloadCounts(payload: unknown): { passed: number; total: number } | null {
  if (payload === null || typeof payload !== 'object') return null;
  const summary = (payload as { summary?: unknown }).summary;
  if (summary === null || typeof summary !== 'object') return null;
  const { passed, total } = summary as { passed?: unknown; total?: unknown };
  return typeof passed === 'number' && typeof total === 'number' ? { passed, total } : null;
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
        const counts = payloadCounts(s.payload);
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
            {counts ? `${counts.passed}/${counts.total} checks` : ''}
            {s.recipe && <Text dimColor> ({s.recipe})</Text>}
            {'  '}
            <Text dimColor>{duration}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
