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
 * The presentational primitives (banner, spinner, run header, etc.)
 * are inlined here using bare `Box`/`Text` from Ink. The cli/ui
 * components that previously lived alongside FitView stay in the CLI
 * package for use by the static-render path in App.tsx (the
 * `fit-done` CommandResult branch); duplicating the small visuals
 * here is the cost of breaking the cli/ui → fitness import edge
 * documented as F3 in docs/plans/architecture/2026-05-22-plan-layer-5-cli.md.
 *
 * Single exit-code write path: errors and shouldFail conditions route
 * through the supplied `setExitCode` callback (`ToolCliContext.setExitCode`)
 * so the CLI keeps its single `process.exitCode` mutator. The
 * historical `process.exitCode = N` writes that lived in FitView are
 * gone.
 */

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
import { Box, Text, useApp, render } from 'ink';
import React, { useCallback, useEffect, useState } from 'react';

import { reportToCloud } from '../sarif.js';

import { ensureChecksLoaded, executeFit, getEnabledCheckCount } from './fit.js';

import type { DataStore } from '@opensip-tools/datastore';

// ---------------------------------------------------------------------------
// Theme — minimal palette, mirrors @opensip-tools/cli's defaults so the live
// view looks the same as the static `cli.render(result)` path. Inlined
// because lang/layer rules forbid tool packages from importing
// @opensip-tools/cli; the tradeoff is documented at the top of this file.
// ---------------------------------------------------------------------------

interface Theme {
  readonly brand: string;
  readonly success: string;
  readonly error: string;
  readonly warning: string;
  readonly info: string;
  readonly muted: string;
  readonly statusPass: string;
  readonly statusFail: string;
  readonly statusTimeout: string;
}

const THEME: Theme = {
  brand: '#C8956C',
  success: 'green',
  error: 'red',
  warning: 'yellow',
  info: 'cyan',
  muted: 'gray',
  statusPass: 'green',
  statusFail: 'red',
  statusTimeout: 'yellow',
};

// ---------------------------------------------------------------------------
// Spinner clock — an interval-driven tick state that drives the braille
// frame rotation. Lifted from @opensip-tools/cli's ClockProvider/useSpinner
// pair; inlined to keep the tool package self-contained.
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = [
  '⠋', '⠙', '⠹', '⠸',
  '⠼', '⠴', '⠦', '⠧',
  '⠇', '⠏',
];
const TICK_INTERVAL_MS = 80;

function useTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setTick((prev) => prev + 1);
    }, TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
  return tick;
}

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

  switch (state.phase) {
    case 'loading': {
      return (
        <Box flexDirection="column">
          {!args.quiet && <Banner />}
          {!args.quiet && (
            <RunHeader
              cwd={args.cwd}
              metadata={[{ label: 'Recipe', value: recipe }]}
            />
          )}
          <Box paddingLeft={2}>
            <SpinnerLine total={0} completed={0} label="Loading checks..." />
          </Box>
        </Box>
      );
    }

    case 'running': {
      return (
        <Box flexDirection="column">
          {!args.quiet && <Banner />}
          {!args.quiet && (
            <RunHeader
              cwd={args.cwd}
              metadata={[
                { label: 'Recipe', value: recipe },
                { label: 'Checks', value: String(state.checkCount) },
              ]}
            />
          )}
          <Box paddingLeft={2}>
            <SpinnerLine total={state.total} completed={state.completed} />
          </Box>
        </Box>
      );
    }

    case 'done': {
      return (
        <Box flexDirection="column">
          {!args.quiet && <Banner />}
          {!args.quiet && (
            <RunHeader
              cwd={args.cwd}
              metadata={[
                { label: 'Recipe', value: recipe },
                { label: 'Checks', value: String(state.checkCount) },
              ]}
            />
          )}
          {!args.quiet && (args.verbose === true || args.findings === true) && (
            <Box paddingTop={1} flexDirection="column">
              <ResultsTable rows={state.result.rows} />
            </Box>
          )}
          <SummaryLine summary={state.result.summary} />
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
      );
    }

    case 'error': {
      return <ErrorLine message={state.result.message} suggestion={state.result.suggestion} />;
    }
  }
}

// ---------------------------------------------------------------------------
// Inline visual primitives — kept simple so the runner stays self-contained.
// Mirrors the cli/ui/components/* counterparts for visual parity; if either
// drifts from the other, App.tsx's static render and the live runner here
// diverge — accepted tradeoff documented at the top of this file.
// ---------------------------------------------------------------------------

const BANNER: readonly [string, string, string][] = [
  ['   ░       ░             ',  '  ██████   ████████  █████████ ████  ███', ' ███████   █████ ████████ '],
  ['    ░     ░              ',  ' ███░░░███░███░░░░██░███░░░░░░░░███  ███', '███░░░░███░░███ ░███░░░░██'],
  ['   ░       ░             ',  '███   ░███░███   ░██░███       ░████ ███', '░███   ░░░ ░███ ░███   ░██'],
  ['███████████████          ',  '███   ░███░████████░░██████    ░██░█████', '░░███████  ░███ ░████████░'],
  ['███████████████  █████   ',  '███   ░███░███░░░░  ░███░░░    ░██ ░████', ' ░░░░░░███ ░███ ░███░░░░  '],
  ['███████████████ ░░░░███  ',  '░███  ████░███      ░███       ░██  ░███', ' ███   ███ ░███ ░███      '],
  ['███████████████  █████   ',  ' ░██████░  ████      █████████ ████  ███', '░░███████  █████ ████     '],
  ['░█████████████░ ░░░      ',  '  ░░░░░░  ░░░░░     ░░░░░░░░░░░░░░  ░░░', ' ░░░░░░░  ░░░░░ ░░░░░     '],
];
const BANNER_SAUCER = ' ░███████████░';

function Banner(): React.ReactElement {
  return (
    <Box flexDirection="column">
      {BANNER.map(([cup, openPart, sipPart], i) => (
        <Text key={i}>
          {cup}
          <Text color={THEME.brand}>{openPart}</Text>
          {' '}
          <Text bold>{sipPart}</Text>
        </Text>
      ))}
      <Text>{BANNER_SAUCER}</Text>
    </Box>
  );
}

interface RunHeaderMeta {
  readonly label: string;
  readonly value: string;
}

function RunHeader({ cwd, metadata }: { readonly cwd: string; readonly metadata: readonly RunHeaderMeta[] }): React.ReactElement {
  const separator = '─'.repeat(60);
  const metaParts = [
    ...metadata.map((m) => `${m.label}: ${m.value}`),
    `Target: ${cwd}`,
  ];
  return (
    <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
      <Text bold color={THEME.brand}>Fitness Checks</Text>
      <Text dimColor>{metaParts.join('   ')}</Text>
      <Text> </Text>
      <Text dimColor>Scanning your codebase for quality, security, and architecture issues.</Text>
      <Text> </Text>
      <Text dimColor>{separator}</Text>
    </Box>
  );
}

interface SpinnerLineProps {
  readonly total: number;
  readonly completed: number;
  readonly label?: string;
}

function SpinnerLine({ total, completed, label = 'Running checks...' }: SpinnerLineProps): React.ReactElement {
  const tick = useTick();
  const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <Text>
      <Text color={THEME.brand}>{frame}</Text>
      {' '}
      {label}
      {total > 0 ? <Text>  {completed}/{total} ({pct}%)</Text> : null}
    </Text>
  );
}

function ErrorLine({ message, suggestion }: { readonly message: string; readonly suggestion?: string }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>
        <Text color={THEME.error}>{'✗'}</Text>
        {' '}
        {message}
      </Text>
      {suggestion && (
        <Text dimColor>{'    '}{suggestion}</Text>
      )}
    </Box>
  );
}

function statusColor(status: TableRow['status']): string {
  if (status === 'FAIL') return THEME.statusFail;
  if (status === 'TIMEOUT') return THEME.statusTimeout;
  return THEME.statusPass;
}

function parseValidatedCount(validated: string): number {
  if (validated === '—') return 0;
  const match = /^(\d+)/.exec(validated);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function ignoredColor(ignored: number, validated: string): string {
  const total = parseValidatedCount(validated);
  if (total === 0 || ignored === 0) return THEME.muted;
  const pct = (ignored / total) * 100;
  if (pct > 10) return THEME.error;
  if (pct > 5) return THEME.warning;
  return THEME.muted;
}

function durationColor(ms: number): string {
  if (ms >= 60_000) return THEME.error;
  if (ms >= 30_000) return THEME.warning;
  return THEME.success;
}

function sortPriority(r: TableRow): number {
  if (r.status === 'TIMEOUT') return 0;
  if (r.status === 'FAIL') return 1;
  if (r.warnings > 0) return 2;
  return 3;
}

function ResultsTable({ rows }: { readonly rows: readonly TableRow[] }): React.ReactElement | null {
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
          <Text color={statusColor(row.status)}>{row.status.padEnd(widths.status)}</Text>
          {' | '}
          <Text color={row.errors > 0 ? THEME.error : THEME.success}>{String(row.errors).padEnd(widths.errors)}</Text>
          {' | '}
          <Text color={row.warnings > 0 ? THEME.warning : THEME.muted}>{String(row.warnings).padEnd(widths.warnings)}</Text>
          {' | '}
          {row.validated.padEnd(widths.validated)}
          {' | '}
          <Text color={ignoredColor(row.ignored, row.validated)}>{String(row.ignored).padEnd(widths.ignored)}</Text>
          {' | '}
          <Text color={durationColor(row.durationMs)}>{row.duration.padEnd(widths.duration)}</Text>
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
  const { passed, failed, totalErrors, totalWarnings, durationMs } = summary;
  return (
    <Box paddingTop={1}>
      <Text>
        <Text color={THEME.success}>{passed} Passed</Text>
        , <Text color={failed > 0 ? THEME.error : THEME.muted}>{failed} Failed</Text>
        {' ('}
        <Text color={totalErrors > 0 ? THEME.error : THEME.muted}>{totalErrors} Errors</Text>
        , <Text color={totalWarnings > 0 ? THEME.warning : THEME.muted}>{totalWarnings} Warnings</Text>
        {') '}
        <Text dimColor>|</Text>
        {' Duration '}
        <Text color={THEME.info}>{formatDurationLine(durationMs)}</Text>
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

function FindingsBlock({ checks }: { readonly checks: readonly CheckOutput[] }): React.ReactElement {
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
              <Text color={THEME.brand}>{check.checkSlug}</Text>
              {' '}
              <Text dimColor>({count})</Text>
            </Text>
            {check.error && (
              <Text>
                {'      '}
                <Text color={THEME.error}>error</Text>
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
                    <Text color={v.severity === 'error' ? THEME.error : THEME.warning}>
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
  const { url, findingCount, runCount, success, error, chunksTotal, chunksSucceeded } = status;
  const chunkDetail = chunksTotal != null && chunksTotal > 1
    ? ` (${chunksSucceeded ?? 0}/${chunksTotal} chunks)`
    : '';

  if (!success) {
    const partial = chunksSucceeded != null && chunksSucceeded > 0;
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          <Text color={partial ? THEME.warning : THEME.error}>{partial ? '⚠' : '✗'}</Text>
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
        <Text color={THEME.success}>{'✔'}</Text>
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
    <FitRunner args={args} datastore={datastore} setExitCode={options?.setExitCode} />,
  );
  await app.waitUntilExit();
  // Trailing newline so shell prompt starts on a new line.
  process.stdout.write('\n');
}
