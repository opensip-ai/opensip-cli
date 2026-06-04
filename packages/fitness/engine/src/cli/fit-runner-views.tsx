/**
 * @fileoverview Tool-specific Ink render pieces for the live fit view.
 *
 * Extracted from `fit-runner.tsx` so the state-machine entry there stays
 * compact. Each component here consumes the run's {@link SignalEnvelope}-
 * derived view-models (`FitTableRow` / `FitFindingsGroup`, built by
 * `fit/envelope-view.ts`) and pulls colours from the shared cli-ui theme. The
 * Banner, RunHeader, Spinner, and ErrorMessage primitives remain owned by
 * `@opensip-tools/cli-ui` — only the fitness-specific renderers live here.
 *
 * ADR-0011 Phase 6: fitness no longer imports `@opensip-tools/output`; the
 * live table/findings derive straight from the envelope (the static/non-TTY
 * path uses the shared `formatSignalTableRows` at the composition root).
 */

import { useTheme, sortFitRowPriority, parseValidatedCount } from '@opensip-tools/cli-ui';
import { Box, Text } from 'ink';
import React from 'react';

import { fitValidatedCell, type FitTableRow, type FitFindingsGroup } from './fit/envelope-view.js';

import type { Signal } from '@opensip-tools/core';

const DEFAULT_VIOLATIONS_PER_CHECK = 25;

function statusColor(theme: ReturnType<typeof useTheme>, status: FitTableRow['status']): string {
  if (status === 'FAIL') return theme.statusFail;
  if (status === 'ERROR') return theme.statusTimeout;
  return theme.statusPass;
}

function ignoredColor(theme: ReturnType<typeof useTheme>, ignored: number, validated: string): string {
  const total = parseValidatedCount(validated);
  if (total === 0 || ignored === 0) return theme.muted;
  const pct = (ignored / total) * 100;
  if (pct > 10) return theme.error;
  if (pct > 5) return theme.warning;
  return theme.muted;
}

function durationColor(theme: ReturnType<typeof useTheme>, ms: number): string {
  if (ms >= 60_000) return theme.error;
  if (ms >= 30_000) return theme.warning;
  return theme.success;
}

export function ResultsTable({ rows }: { readonly rows: readonly FitTableRow[] }): React.ReactElement | null {
  const theme = useTheme();
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => sortFitRowPriority(a) - sortFitRowPriority(b));
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
      {sorted.map((row, i) => {
        const validatedCell = fitValidatedCell(row);
        return (
          <Text key={i}>
            {row.check.padEnd(maxCheckWidth)}
            {' | '}
            <Text color={statusColor(theme, row.status)}>{row.status.padEnd(widths.status)}</Text>
            {' | '}
            <Text color={row.errors > 0 ? theme.error : theme.success}>{String(row.errors).padEnd(widths.errors)}</Text>
            {' | '}
            <Text color={row.warnings > 0 ? theme.warning : theme.muted}>{String(row.warnings).padEnd(widths.warnings)}</Text>
            {' | '}
            {validatedCell.padEnd(widths.validated)}
            {' | '}
            <Text color={ignoredColor(theme, row.ignored, validatedCell)}>{String(row.ignored).padEnd(widths.ignored)}</Text>
            {' | '}
            <Text color={durationColor(theme, row.durationMs)}>{row.duration.padEnd(widths.duration)}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

// SummaryLine previously lived here — now provided by
// `@opensip-tools/cli-ui`'s shared `RunSummary` component so fit, graph,
// and future tools render the same single-line summary at the bottom
// of every run. fit-runner.tsx imports `RunSummary` directly.

/**
 * WarningsBlock — renders non-fatal user-facing warnings collected during
 * the run (plugin load failures, unknown languages in config, missing
 * check packages, etc.).
 *
 * These come through `FitDoneResult.warnings` rather than direct stderr
 * writes — emitting them during an active Ink render desyncs the renderer's
 * frame tracking. Rendering them here through Ink keeps the live view's
 * frame contract intact.
 */
export function WarningsBlock({ warnings }: { readonly warnings: readonly string[] }): React.ReactElement {
  const theme = useTheme();
  return (
    <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
      {warnings.map((msg, i) => (
        <Text key={i} color={theme.warning}>
          {'! '}{msg}
        </Text>
      ))}
    </Box>
  );
}

/** A single finding's location string (`file:line`), or '' when no location. */
function locationOf(signal: Signal): string {
  if (!signal.filePath) return '';
  return signal.line ? `${signal.filePath}:${signal.line}` : signal.filePath;
}

export function FindingsBlock({ groups }: { readonly groups: readonly FitFindingsGroup[] }): React.ReactElement {
  const theme = useTheme();
  const total = groups.reduce(
    (sum, g) => sum + g.errorCount + g.warningCount + (g.error ? 1 : 0),
    0,
  );

  const anyTruncated = groups.some(
    (g) => g.findings.length > DEFAULT_VIOLATIONS_PER_CHECK,
  );

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>
        <Text bold>Findings</Text>
        {' '}
        <Text dimColor>({total})</Text>
        :
      </Text>
      <Text> </Text>
      {groups.map((group) => {
        const count = group.errorCount + group.warningCount + (group.error ? 1 : 0);
        const visible = group.findings.slice(0, DEFAULT_VIOLATIONS_PER_CHECK);
        const hidden = Math.max(0, group.findings.length - visible.length);
        return (
          <Box key={group.checkSlug} flexDirection="column" marginLeft={2}>
            <Text>
              <Text color={theme.brand}>{group.checkSlug}</Text>
              {' '}
              <Text dimColor>({count})</Text>
            </Text>
            {group.error && (
              <Text>
                {'      '}
                <Text color={theme.error}>error</Text>
                {'  '}
                {group.error}
              </Text>
            )}
            {visible.map((v, i) => {
              const loc = locationOf(v);
              const isError = v.severity === 'critical' || v.severity === 'high';
              return (
                <Box key={i} flexDirection="column">
                  <Text>
                    {'      '}
                    <Text color={isError ? theme.error : theme.warning}>
                      {isError ? 'error' : 'warn'}
                    </Text>
                    {'  '}
                    {v.message}
                    {loc ? ' ' : ''}
                    {loc && <Text dimColor>{loc}</Text>}
                  </Text>
                  {v.suggestion && (
                    <Text dimColor>{'            '}{v.suggestion}</Text>
                  )}
                </Box>
              );
            })}
            {hidden > 0 && (
              <Text dimColor>{'      '}… {hidden} more hidden (use <Text bold>--json</Text> or <Text bold>opensip-tools dashboard</Text> for all)</Text>
            )}
            <Text> </Text>
          </Box>
        );
      })}
      {anyTruncated && (
        <Text dimColor>
          {'  '}
          Showing first {DEFAULT_VIOLATIONS_PER_CHECK} violations per check. For the full set, run with
          {' '}<Text bold>--json</Text>{' '}or open
          {' '}<Text bold>opensip-tools dashboard</Text>.
        </Text>
      )}
    </Box>
  );
}
