/**
 * @fileoverview Tool-specific Ink render pieces for the live fit view.
 *
 * Extracted from `fit-runner.tsx` so the state-machine entry there
 * stays compact. Each component here consumes FitDoneResult-shaped
 * data and pulls colours from the shared cli-ui theme. The Banner,
 * RunHeader, Spinner, and ErrorMessage primitives remain owned by
 * `@opensip-tools/cli-ui` — only the fitness-specific renderers live
 * here.
 */

import { useTheme } from '@opensip-tools/cli-ui';
/* eslint-disable sonarjs/deprecation -- intentional adapter usage; fit-runner consumes the CliArgs shape produced by fit's *OptsToCliArgs adapter until the rip-out */
import {
  type CheckOutput,
  type FitDoneResult,
  type TableRow,
} from '@opensip-tools/contracts';
/* eslint-enable sonarjs/deprecation */
import { Box, Text } from 'ink';
import React from 'react';

export const DEFAULT_VIOLATIONS_PER_CHECK = 25;

interface CheckCounts {
  errorCount: number;
  warningCount: number;
}

function countBySeverity(check: CheckOutput): CheckCounts {
  let errorCount = 0;
  let warningCount = 0;
  for (const f of check.findings) {
    if (f.severity === 'error') errorCount++;
    else warningCount++;
  }
  return { errorCount, warningCount };
}

function statusColor(theme: ReturnType<typeof useTheme>, status: TableRow['status']): string {
  if (status === 'FAIL') return theme.statusFail;
  if (status === 'TIMEOUT') return theme.statusTimeout;
  return theme.statusPass;
}

function parseValidatedCount(validated: string): number {
  if (validated === '—') return 0;
  const match = /^(\d+)/.exec(validated);
  return match ? Number.parseInt(match[1], 10) : 0;
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

function sortPriority(r: TableRow): number {
  if (r.status === 'TIMEOUT') return 0;
  if (r.status === 'FAIL') return 1;
  if (r.warnings > 0) return 2;
  return 3;
}

export function ResultsTable({ rows }: { readonly rows: readonly TableRow[] }): React.ReactElement | null {
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
          <Text color={statusColor(theme, row.status)}>{row.status.padEnd(widths.status)}</Text>
          {' | '}
          <Text color={row.errors > 0 ? theme.error : theme.success}>{String(row.errors).padEnd(widths.errors)}</Text>
          {' | '}
          <Text color={row.warnings > 0 ? theme.warning : theme.muted}>{String(row.warnings).padEnd(widths.warnings)}</Text>
          {' | '}
          {row.validated.padEnd(widths.validated)}
          {' | '}
          <Text color={ignoredColor(theme, row.ignored, row.validated)}>{String(row.ignored).padEnd(widths.ignored)}</Text>
          {' | '}
          <Text color={durationColor(theme, row.durationMs)}>{row.duration.padEnd(widths.duration)}</Text>
        </Text>
      ))}
    </Box>
  );
}

function formatDurationLine(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function SummaryLine({ summary }: { readonly summary: FitDoneResult['summary'] }): React.ReactElement {
  const theme = useTheme();
  const { passed, failed, totalErrors, totalWarnings, durationMs } = summary;
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
        <Text color={theme.info}>{formatDurationLine(durationMs)}</Text>
      </Text>
    </Box>
  );
}

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

export function FindingsBlock({ checks }: { readonly checks: readonly CheckOutput[] }): React.ReactElement {
  const theme = useTheme();
  const total = checks.reduce((sum, c) => {
    const { errorCount, warningCount } = countBySeverity(c);
    return sum + errorCount + warningCount + (c.error ? 1 : 0);
  }, 0);

  const relevant = checks.filter((c) => {
    const { errorCount, warningCount } = countBySeverity(c);
    return errorCount > 0 || warningCount > 0 || c.error;
  });

  const anyTruncated = relevant.some(
    (c) => c.findings.length > DEFAULT_VIOLATIONS_PER_CHECK,
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
      {relevant.map((check) => {
        const { errorCount, warningCount } = countBySeverity(check);
        const count = errorCount + warningCount + (check.error ? 1 : 0);
        const visible = check.findings.slice(0, DEFAULT_VIOLATIONS_PER_CHECK);
        const hidden = Math.max(0, check.findings.length - visible.length);
        return (
          <Box key={check.checkSlug} flexDirection="column" marginLeft={2}>
            <Text>
              <Text color={theme.brand}>{check.checkSlug}</Text>
              {' '}
              <Text dimColor>({count})</Text>
            </Text>
            {check.error && (
              <Text>
                {'      '}
                <Text color={theme.error}>error</Text>
                {'  '}
                {check.error}
              </Text>
            )}
            {visible.map((v, i) => {
              const lineSuffix = v.line ? `:${v.line}` : '';
              const loc = v.filePath ? `${v.filePath}${lineSuffix}` : '';
              return (
                <Box key={i} flexDirection="column">
                  <Text>
                    {'      '}
                    <Text color={v.severity === 'error' ? theme.error : theme.warning}>
                      {v.severity === 'error' ? 'error' : 'warn'}
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

type ReportStatusShape = NonNullable<FitDoneResult['reportStatus']>;

export function CloudReportStatusLine({ status }: { readonly status: ReportStatusShape }): React.ReactElement {
  const theme = useTheme();
  const { url, findingCount, runCount, success, error, chunksTotal, chunksSucceeded } = status;
  const chunkDetail = chunksTotal != null && chunksTotal > 1
    ? ` (${chunksSucceeded ?? 0}/${chunksTotal} chunks)`
    : '';

  if (!success) {
    const partial = chunksSucceeded != null && chunksSucceeded > 0;
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          <Text color={partial ? theme.warning : theme.error}>{partial ? '⚠' : '✗'}</Text>
          {' '}
          {partial ? 'Partially reported' : 'Failed to report'} to <Text dimColor>{url}</Text>{chunkDetail}
        </Text>
        {error && <Text dimColor>{'    '}{error}</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>
        <Text color={theme.success}>{'✔'}</Text>
        {' '}
        Reported to <Text dimColor>{url}</Text>{chunkDetail}
      </Text>
      <Text dimColor>
        {'    '}
        {findingCount} findings from {runCount} checks
      </Text>
    </Box>
  );
}
