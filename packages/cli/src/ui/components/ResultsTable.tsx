/**
 * ResultsTable component — renders the fitness check results table.
 */

import { Text, Box } from 'ink';
import React from 'react';

import { useTheme, type Theme } from '../theme.js';

import type { TableRow } from '@opensip-tools/contracts';

export interface ResultsTableProps {
  readonly rows: TableRow[];
}

/** Sort priority: TIMEOUT > FAIL > warnings > PASS */
function sortPriority(r: TableRow): number {
  if (r.status === 'TIMEOUT') return 0;
  if (r.status === 'FAIL') return 1;
  if (r.warnings > 0) return 2;
  return 3;
}

function statusColor(status: TableRow['status'], theme: Theme): string {
  if (status === 'FAIL') return theme.statusFail;
  if (status === 'TIMEOUT') return theme.statusTimeout;
  return theme.statusPass;
}

function errorColor(count: number, theme: Theme): string {
  return count > 0 ? theme.error : theme.success;
}

function warningColor(count: number, theme: Theme): string {
  return count > 0 ? theme.warning : theme.muted;
}

/** Parse the numeric count from a validated string like "450 files". Returns 0 for "—" or unparseable. */
function parseValidatedCount(validated: string): number {
  if (validated === '—') return 0;
  const match = /^(\d+)/.exec(validated);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function ignoredColor(ignored: number, validated: string, theme: Theme): string {
  const total = parseValidatedCount(validated);
  if (total === 0 || ignored === 0) return theme.muted;
  const pct = (ignored / total) * 100;
  if (pct > 10) return theme.error;
  if (pct > 5) return theme.warning;
  return theme.muted;
}

function durationColor(ms: number, theme: Theme): string {
  if (ms >= 60_000) return theme.error;
  if (ms >= 30_000) return theme.warning;
  return theme.success;
}

export function ResultsTable({ rows }: ResultsTableProps): React.ReactElement | null {
  const theme = useTheme();

  if (rows.length === 0) return null;

  const sorted = [...rows].sort((a, b) => sortPriority(a) - sortPriority(b));

  const maxCheckWidth = Math.max(40, ...sorted.map((r) => r.check.length));
  const widths = { status: 7, errors: 6, warnings: 8, validated: 12, ignored: 7, duration: 10 };

  const headerCells = [
    'Check'.padEnd(maxCheckWidth),
    'Status'.padEnd(widths.status),
    'Errors'.padEnd(widths.errors),
    'Warnings'.padEnd(widths.warnings),
    'Validated'.padEnd(widths.validated),
    'Ignores'.padEnd(widths.ignored),
    'Duration'.padEnd(widths.duration),
  ];

  const separatorCells = [
    '-'.repeat(maxCheckWidth),
    '-'.repeat(widths.status),
    '-'.repeat(widths.errors),
    '-'.repeat(widths.warnings),
    '-'.repeat(widths.validated),
    '-'.repeat(widths.ignored),
    '-'.repeat(widths.duration),
  ];

  return (
    <Box flexDirection="column">
      <Text>{headerCells.join(' | ')}</Text>
      <Text>{separatorCells.join('-|-')}</Text>
      {sorted.map((row, i) => (
        <Text key={i}>
          {row.check.padEnd(maxCheckWidth)}
          {' | '}
          <Text color={statusColor(row.status, theme)}>{row.status.padEnd(widths.status)}</Text>
          {' | '}
          <Text color={errorColor(row.errors, theme)}>{String(row.errors).padEnd(widths.errors)}</Text>
          {' | '}
          <Text color={warningColor(row.warnings, theme)}>{String(row.warnings).padEnd(widths.warnings)}</Text>
          {' | '}
          {row.validated.padEnd(widths.validated)}
          {' | '}
          <Text color={ignoredColor(row.ignored, row.validated, theme)}>{String(row.ignored).padEnd(widths.ignored)}</Text>
          {' | '}
          <Text color={durationColor(row.durationMs, theme)}>{row.duration.padEnd(widths.duration)}</Text>
        </Text>
      ))}
    </Box>
  );
}
