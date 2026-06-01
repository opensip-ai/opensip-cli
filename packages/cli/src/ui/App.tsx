/**
 * App — top-level Ink component that dispatches on CommandResult.type.
 */

import { RunHeader , useTheme , ErrorMessage , Banner , UpdateHint , normalizeBannerSize , ProjectHeader } from '@opensip-tools/cli-ui';
import { Text, Box } from 'ink';
import React from 'react';


import { CheckList } from './components/CheckList.js';
import { CloudReportStatus } from './components/CloudReportStatus.js';
import { ExperimentalNotice } from './components/ExperimentalNotice.js';
import { Findings } from './components/Findings.js';
import { HelpText } from './components/HelpText.js';
import { HistoryTable } from './components/HistoryTable.js';
import { InitFeedback } from './components/InitFeedback.js';
import { PluginFeedback } from './components/PluginFeedback.js';
import { RecipeList } from './components/RecipeList.js';
import { ResultsTable } from './components/ResultsTable.js';
import { Summary } from './components/Summary.js';


import type {
  ClearDoneResult,
  CommandResult,
  ConfigureDoneResult,
  SimDoneResult,
  UninstallDoneResult,
} from '@opensip-tools/contracts';
import type { UiContext } from '@opensip-tools/core';

/** Project location for the shell's `ℹ Project:` line. */
export interface ProjectHeaderProps {
  readonly root: string;
  readonly walkedUp: number;
}

export interface AppProps {
  readonly result: CommandResult;
  /** Omitted for project-agnostic commands (init/configure/completion) and scopeless error paths. */
  readonly projectHeader?: ProjectHeaderProps;
  /** Presentation settings (banner size + version). Omitted on scopeless paths. */
  readonly ui?: UiContext;
}

/**
 * Result types that render WITHOUT the banner. `error` stays terse — a
 * bare `✗` line reads better in CI logs and above a stack of error text.
 * `--json` and `completion` never reach this component (they bypass the
 * Ink render seam entirely), so they need no entry here.
 */
const BANNERLESS_RESULT_TYPES: ReadonlySet<CommandResult['type']> = new Set(['error']);

/** Display title for the simulation tool — shared by its two render branches. */
const SIMULATION_TOOL_TITLE = 'Simulation';

/**
 * App shell — the single source of truth for banner visibility. Renders
 * the banner once for every human-facing command, then delegates the
 * body to {@link AppBody}. Replaces the prior per-branch `<Banner/>`
 * sprinkling that left `dashboard` (and the list/plugin/configure/
 * uninstall commands) with no banner at all.
 */
export function App({ result, projectHeader, ui }: AppProps): React.ReactElement {
  const showBanner = !BANNERLESS_RESULT_TYPES.has(result.type);
  const bannerSize = normalizeBannerSize(ui?.bannerSize);
  // `mini` carries the project path inside its boxed card, so the separate
  // `ℹ Project:` line would duplicate it — suppress ProjectHeader for mini.
  // Every other size renders the banner art only, with ProjectHeader below.
  const showProjectHeader = bannerSize !== 'mini' && projectHeader !== undefined;
  return (
    <Box flexDirection="column">
      {showBanner && (
        <Banner
          size={bannerSize}
          version={ui?.version}
          projectPath={projectHeader?.root}
          walkedUp={projectHeader?.walkedUp}
          update={ui?.update}
        />
      )}
      {showBanner && bannerSize === 'mini' && ui?.update !== undefined && <UpdateHint />}
      {showBanner && showProjectHeader && (
        <ProjectHeader root={projectHeader.root} walkedUp={projectHeader.walkedUp} />
      )}
      <AppBody result={result} />
    </Box>
  );
}

/**
 * Dispatches on `CommandResult.type`. Body only — the banner is owned by
 * {@link App}, so no branch renders its own.
 */
function AppBody({ result }: AppProps): React.ReactElement {
  switch (result.type) {
    case 'fit-done': {
      return (
        <Box flexDirection="column">
          <ResultsTable rows={result.rows} />
          <Summary {...result.summary} />
          {result.findings && <Findings checks={result.findings.checks} />}
          {result.reportStatus && <CloudReportStatus {...result.reportStatus} />}
        </Box>
      );
    }

    case 'list-checks': {
      return <CheckList checks={result.checks} totalCount={result.totalCount} />;
    }

    case 'list-recipes': {
      return <RecipeList recipes={result.recipes} />;
    }

    case 'history': {
      return <HistoryTable sessions={result.sessions} />;
    }

    case 'dashboard': {
      return <DashboardFeedback path={result.path} opened={result.opened} />;
    }

    case 'init': {
      return <InitFeedback {...result} />;
    }

    case 'experimental': {
      const toolDesc = 'Run scenario-based tests against your codebase.';
      return (
        <Box flexDirection="column">
          <RunHeader tool={SIMULATION_TOOL_TITLE} description={toolDesc} />
          <ExperimentalNotice tool={result.tool} cwd={result.cwd} />
        </Box>
      );
    }

    case 'sim-done': {
      return <SimDoneSummary result={result} />;
    }

    case 'plugin-list':
    case 'plugin-add':
    case 'plugin-remove':
    case 'plugin-sync': {
      return <PluginFeedback result={result} />;
    }

    case 'clear-done': {
      return <ClearDoneSummary result={result} />;
    }

    case 'configure-done': {
      return <ConfigureDoneSummary result={result} />;
    }

    case 'uninstall-done': {
      return <UninstallDoneSummary result={result} />;
    }

    case 'help': {
      return <HelpText />;
    }

    case 'error': {
      return <ErrorMessage message={result.message} suggestion={result.suggestion} />;
    }

    default: {
      return <ErrorMessage message="Unknown command result" />;
    }
  }
}

/**
 * Inline summary for `sim --recipe <name>` runs.
 *
 * Mirrors the fit-done compact summary: one line per scenario, then a
 * pass/fail tally + duration. Detailed per-scenario error messages
 * surface inline when a scenario failed.
 */
function SimDoneSummary({
  result,
}: Readonly<{ result: SimDoneResult }>): React.ReactElement {
  const theme = useTheme();
  const ms = result.durationMs;
  const dur = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

  return (
    <Box flexDirection="column">
      <RunHeader
        tool={SIMULATION_TOOL_TITLE}
        description={`Recipe: ${result.recipeName}`}
      />
      <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
        {result.scenarios.length === 0 ? (
          <Text dimColor>
            No scenarios matched recipe '{result.recipeName}'. Add one to opensip-tools/sim/scenarios/.
          </Text>
        ) : (
          result.scenarios.map((s) => (
            <Box key={s.scenarioId} flexDirection="column">
              <Text>
                <Text color={s.passed ? theme.success : theme.error}>
                  {s.passed ? '✓' : '✗'}
                </Text>
                {' '}
                <Text bold>{s.scenarioName}</Text>
                {' '}
                <Text dimColor>({s.kind}, {s.durationMs}ms)</Text>
              </Text>
              {s.error && (
                <Box paddingLeft={4}>
                  <Text color={theme.error}>{s.error}</Text>
                </Box>
              )}
            </Box>
          ))
        )}
      </Box>
      <Box paddingLeft={2} paddingTop={1}>
        <Text>
          <Text bold>{result.passedScenarios}</Text> passed,{' '}
          <Text bold color={result.failedScenarios > 0 ? theme.error : undefined}>
            {result.failedScenarios}
          </Text>{' '}
          failed
          {' '}
          <Text dimColor>| Duration {dur}</Text>
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Inline summary for `opensip-tools sessions purge` runs.
 *
 * Phase 6 of the Layer 5 plan: this branch was previously dead because
 * `clear.ts` wrote its banner via raw ANSI before returning. Now
 * `executeClear` returns a structured `ClearDoneResult` and Ink owns
 * the entire render — banner, success/cancel/empty messages, and the
 * deletion count.
 */
function ClearDoneSummary({ result }: Readonly<{ result: ClearDoneResult }>): React.ReactElement {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      <Box paddingLeft={2} paddingTop={1}>
        {result.action === 'empty' && <Text dimColor>No session data to clear.</Text>}
        {result.action === 'cancelled' && <Text dimColor>Cancelled. No data was deleted.</Text>}
        {result.action === 'done' && (
          <Text>
            <Text color={theme.success}>{'✓'}</Text>
            {' '}{result.deletedCount} session{result.deletedCount === 1 ? '' : 's'} deleted.
          </Text>
        )}
      </Box>
    </Box>
  );
}

/** Inline summary for `opensip-tools configure` runs. */
function ConfigureDoneSummary({ result }: Readonly<{ result: ConfigureDoneResult }>): React.ReactElement {
  const theme = useTheme();
  if (result.action === 'cancelled') {
    return (
      <Box paddingLeft={2}>
        <Text dimColor>No key provided. Configuration unchanged.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>
        <Text color={theme.success}>{'✓'}</Text>
        {' '}API key saved to <Text bold>{result.configPath}</Text>
      </Text>
      <Text dimColor>
        {'  '}You can now use --report-to to send results to OpenSIP Cloud.
      </Text>
    </Box>
  );
}

/**
 * Inline summary for `opensip-tools uninstall` runs.
 *
 * Replaces the prior raw-stdout success line + next-step hint that
 * bypassed the theme. Audit 2026-05-23 G5.
 */
function UninstallDoneSummary({ result }: Readonly<{ result: UninstallDoneResult }>): React.ReactElement {
  const theme = useTheme();
  const sizeText = formatBytes(result.sizeBytes);
  const targetCount = result.targets.length;

  if (result.action === 'empty') {
    return (
      <Box paddingLeft={2}>
        <Text dimColor>Nothing to remove at {result.rootPath}.</Text>
      </Box>
    );
  }

  if (result.action === 'cancelled') {
    return (
      <Box paddingLeft={2}>
        <Text dimColor>Cancelled. No changes made.</Text>
      </Box>
    );
  }

  if (result.action === 'dry-run') {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text dimColor>
          [dry-run] No changes made. Re-run without --dry-run to remove
          {' '}{targetCount} target{targetCount === 1 ? '' : 's'} ({sizeText}).
        </Text>
      </Box>
    );
  }

  // action === 'removed'
  const hint = result.mode === 'user'
    ? 'To remove the CLI itself: npm uninstall -g opensip-tools'
    : 'To also remove user-level config: opensip-tools uninstall';
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>
        <Text color={theme.success}>{'✓'}</Text>
        {' '}Removed {targetCount} target{targetCount === 1 ? '' : 's'}
        {' '}<Text dimColor>({sizeText})</Text>
      </Text>
      <Text dimColor>  {hint}</Text>
    </Box>
  );
}

/** Mirror of `formatUninstallSize` so the renderer doesn't reach into commands/. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Inline dashboard feedback component */
function DashboardFeedback({ path, opened }: Readonly<{ path: string; opened: boolean }>): React.ReactElement {
  const theme = useTheme();
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>
        <Text color={theme.success}>{'\u2713'}</Text>
        {' '}
        Report written to <Text bold>{path}</Text>
      </Text>
      <Text dimColor>
        {'  '}{opened ? 'Opened in browser.' : 'Open the file in your browser to view.'}
      </Text>
    </Box>
  );
}

