/**
 * fit-runner — owns the live-view state machine for `opensip-tools fit`.
 *
 * Layer 5 Phase 3 lifted the fit live view out of `@opensip-tools/cli`.
 * The state machine (loading → running → done | error), `executeFit`
 * orchestration, `reportToCloud` post-call, and the Ink/React render
 * tree all live here, in the package that owns the fitness command
 * surface. Adding a fourth tool with a live view requires zero CLI
 * edits — each tool ships its own renderer and registers it via
 * `cli.registerLiveView(key, renderer)`.
 *
 * Shared presentational primitives (Banner, RunHeader, Spinner, theme
 * tokens) come from `@opensip-tools/cli-ui`. Tool-specific render
 * pieces (results table, findings block, cloud-report status) stay
 * inline here because they consume FitDoneResult-shaped data.
 *
 * Single exit-code write path: errors and shouldFail conditions route
 * through the supplied `setExitCode` callback (`ToolCliContext.setExitCode`)
 * so the CLI keeps its single `process.exitCode` mutator. The
 * historical `process.exitCode = N` writes that lived in FitView are
 * gone.
 */

import {
  Banner,
  ClockProvider,
  ErrorMessage,
  RunHeader,
  Spinner,
  ThemeProvider,
  useTheme,
} from '@opensip-tools/cli-ui';
/* eslint-disable sonarjs/deprecation -- intentional adapter usage; fit-runner consumes the CliArgs shape produced by fit's *OptsToCliArgs adapter until the rip-out */
import {
  type CheckOutput,
  type CliArgs,
  type CliOutput,
  type ErrorResult,
  type FitDoneResult,
  type TableRow,
} from '@opensip-tools/contracts';
/* eslint-enable sonarjs/deprecation */
import { Box, Static, Text, useApp, render } from 'ink';
import React, { useCallback, useEffect, useState } from 'react';

import { reportToCloud } from '../sarif.js';

import { ensureChecksLoaded, executeFit, getEnabledCheckCount } from './fit.js';

import type { DataStore } from '@opensip-tools/datastore';

// Theme constants used by tool-specific sub-components below. The shared
// presentational primitives (Banner, RunHeader, Spinner, ErrorMessage)
// pull their colors from cli-ui's ThemeProvider; the tool-specific
// renderers (ResultsTable, SummaryLine, FindingsBlock, CloudReportStatus)
// also use useTheme() to stay consistent.
const FIT_TOOL_TITLE = 'Fitness Checks';
const FIT_TOOL_DESCRIPTION =
  'Scanning your codebase for quality, security, and architecture issues.';

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type FitState =
  | { phase: 'loading' }
  | { phase: 'running'; completed: number; total: number; checkCount: number }
  | { phase: 'done'; result: FitDoneResult; checkCount: number }
  | { phase: 'error'; result: ErrorResult };

interface FitRunnerProps {
  // eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
  readonly args: CliArgs;
  readonly datastore?: DataStore;
  readonly setExitCode?: (code: number) => void;
}

function FitRunner({ args, datastore, setExitCode }: FitRunnerProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<FitState>({ phase: 'loading' });

  // Progress-state machine: `executeFit` calls back with a monotonic
  // (completed, total) pair via `buildFitCallbacks` in fit.ts. The
  // useCallback identity is stable across renders so the underlying
  // `useEffect` does not re-fire on each tick.
  const onProgress = useCallback((completed: number, total: number) => {
    setState((prev) =>
      prev.phase === 'running'
        ? { ...prev, completed, total }
        : prev,
    );
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // Phase 1: Load checks to get count for header
      await ensureChecksLoaded(args.cwd);
      const checkCount = getEnabledCheckCount();

      if (cancelled) return;
      setState({ phase: 'running', completed: 0, total: 0, checkCount });

      // Phase 2: Execute. Pass `onProgress` so the spinner ticks live,
      // and `datastore` so the run lands in the SQLite session history
      // (the JSON path goes through tool.ts's runJsonMode and threads
      // its own copy).
      const fitResult = await executeFit(args, { onProgress, datastore });

      if (cancelled) return;

      if (fitResult.result.type === 'error') {
        setState({ phase: 'error', result: fitResult.result });
        setExitCode?.(fitResult.result.exitCode);
        setTimeout(() => exit(), 100);
        return;
      }

      const { result, output } = fitResult as { result: FitDoneResult; output: CliOutput };

      // Cloud reporting
      let finalResult: FitDoneResult = result;
      if (args.reportTo && output) {
        const reportStatus = await reportToCloud(output, args.reportTo, args.apiKey);
        finalResult = reportStatus ? { ...result, reportStatus } : result;
      }

      if (finalResult.shouldFail) {
        setExitCode?.(1);
      }

      setState({ phase: 'done', result: finalResult, checkCount });
      setTimeout(() => exit(), 100);
    })();

    return () => { cancelled = true; };
  }, []);

  const recipe = args.tags ? `tags: ${args.tags}` : (args.recipe ?? 'default');

  // Banner + RunHeader both live in <Static> so Ink writes them once above the
  // dynamic redraw region and never touches those bytes again. The dynamic
  // region contains ONLY the things that actually change between frames
  // (spinner during loading/running; summary block during done) — small,
  // stable-width content that Ink can redraw without its line-clear heuristic
  // miscounting and producing overdraw.
  //
  // Static is incremental: items added in later renders are appended below
  // existing static content. We start with just the banner (we don't know
  // checkCount yet during loading), and append the header once checkCount is
  // known. RunHeader's metadata only changes once (when loading→running), and
  // after that it's stable for the rest of the run — perfect Static fit.
  const checkCount = state.phase === 'running' || state.phase === 'done' ? state.checkCount : null;
  const staticItems = computeStaticItems(args.quiet === true, checkCount);

  const renderStaticItem = (item: 'banner' | 'header'): React.ReactElement => {
    if (item === 'banner') return <Banner key={item} />;
    const metadata = [
      { label: 'Recipe', value: recipe },
      { label: 'Checks', value: String(checkCount) },
    ];
    return (
      <RunHeader
        key={item}
        tool={FIT_TOOL_TITLE}
        description={FIT_TOOL_DESCRIPTION}
        projectRoot={args.cwd}
        metadata={metadata}
      />
    );
  };

  const staticHeader = (
    <Static items={staticItems}>
      {renderStaticItem}
    </Static>
  );

  switch (state.phase) {
    case 'loading': {
      return (
        <>
          {staticHeader}
          <Box paddingLeft={2} paddingTop={1}>
            <Spinner total={0} completed={0} label="Loading checks..." />
          </Box>
        </>
      );
    }

    case 'running': {
      return (
        <>
          {staticHeader}
          <Box paddingLeft={2}>
            <Spinner total={state.total} completed={state.completed} label="Running checks..." />
          </Box>
        </>
      );
    }

    case 'done': {
      return (
        <>
          {staticHeader}
          <Box flexDirection="column">
          {!args.quiet && (args.verbose === true || args.findings === true) && (
            <Box paddingTop={1} flexDirection="column">
              <ResultsTable rows={state.result.rows} />
            </Box>
          )}
          <SummaryLine summary={state.result.summary} />
          {!args.quiet && state.result.warnings && state.result.warnings.length > 0 && (
            <WarningsBlock warnings={state.result.warnings} />
          )}
          {!args.quiet && state.result.findings && (
            <FindingsBlock checks={state.result.findings.checks} />
          )}
          {!args.quiet && state.result.reportStatus && (
            <CloudReportStatusLine status={state.result.reportStatus} />
          )}
          {!args.quiet && args.verbose !== true && args.findings !== true && (
            <Box paddingTop={1} paddingLeft={2}>
              <Text dimColor>
                Use <Text bold>--verbose</Text> for detailed results | <Text bold>opensip-tools dashboard</Text> for HTML report | <Text bold>--report-to {'<url>'}</Text> to send to OpenSIP
              </Text>
            </Box>
          )}
          {!args.quiet && state.result.configFound === false && (
            <Box paddingLeft={2}>
              <Text dimColor>
                No config file found. Run <Text bold>opensip-tools init</Text> to customize targets and settings.
              </Text>
            </Box>
          )}
          </Box>
        </>
      );
    }

    case 'error': {
      return <ErrorMessage message={state.result.message} suggestion={state.result.suggestion} />;
    }
  }
}

// ---------------------------------------------------------------------------
// Tool-specific render pieces — consume FitDoneResult-shaped data and use
// the shared theme via useTheme(). Banner / RunHeader / Spinner / ErrorMessage
// come from @opensip-tools/cli-ui (imported at the top).
// ---------------------------------------------------------------------------

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

function ResultsTable({ rows }: { readonly rows: readonly TableRow[] }): React.ReactElement | null {
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

function SummaryLine({ summary }: { readonly summary: FitDoneResult['summary'] }): React.ReactElement {
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

const DEFAULT_VIOLATIONS_PER_CHECK = 25;

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

/**
 * Compute the Static items list for the current frame. Items are append-only:
 * `'banner'` is present once the run starts; `'header'` joins once checkCount
 * is known (after loading). In quiet mode, the list stays empty so the Static
 * tree renders nothing.
 */
function computeStaticItems(quiet: boolean, checkCount: number | null): ('banner' | 'header')[] {
  if (quiet) return [];
  if (checkCount === null) return ['banner'];
  return ['banner', 'header'];
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
function WarningsBlock({ warnings }: { readonly warnings: readonly string[] }): React.ReactElement {
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

function FindingsBlock({ checks }: { readonly checks: readonly CheckOutput[] }): React.ReactElement {
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

function CloudReportStatusLine({ status }: { readonly status: ReportStatusShape }): React.ReactElement {
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

// ---------------------------------------------------------------------------
// Public entry — registered with the CLI via `cli.registerLiveView('fit', ...)`.
// ---------------------------------------------------------------------------

export interface RenderFitLiveOptions {
  readonly setExitCode?: (code: number) => void;
}

/**
 * Render the live `fit` view. Returns once the underlying Ink app exits.
 *
 * The CLI's `tool.register(cli)` wires this through
 * `cli.registerLiveView('fit', (args) => renderFitLive(args, { ... }))`.
 * `setExitCode` is the single mutator path on `process.exitCode`; the
 * runner calls it for error and `shouldFail` outcomes so the CLI's
 * exit-code seam stays the only writer.
 */
export async function renderFitLive(
  // eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
  args: CliArgs,
  datastore?: DataStore,
  options?: RenderFitLiveOptions,
): Promise<void> {
  const app = render(
    <ThemeProvider>
      <ClockProvider>
        <FitRunner args={args} datastore={datastore} setExitCode={options?.setExitCode} />
      </ClockProvider>
    </ThemeProvider>,
  );
  await app.waitUntilExit();
  // Trailing newline so shell prompt starts on a new line.
  process.stdout.write('\n');
}
