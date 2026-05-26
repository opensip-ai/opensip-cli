/**
 * App — top-level Ink component that dispatches on CommandResult.type.
 */

import { RunHeader , useTheme } from '@opensip-tools/cli-ui';
import { Text, Box } from 'ink';
import React from 'react';


import { Banner } from './components/Banner.js';
import { CheckList } from './components/CheckList.js';
import { CloudReportStatus } from './components/CloudReportStatus.js';
import { ErrorMessage } from './components/ErrorMessage.js';
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

export interface AppProps {
  readonly result: CommandResult;
}

export function App({ result }: AppProps): React.ReactElement {
  switch (result.type) {
    case 'fit-done': {
      return (
        <Box flexDirection="column">
          <Banner />
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
      return (
        <Box flexDirection="column">
          {result.created && <Banner />}
          <InitFeedback {...result} />
        </Box>
      );
    }

    case 'experimental': {
      const toolName = 'Simulation';
      const toolDesc = 'Run scenario-based tests against your codebase.';
      return (
        <Box flexDirection="column">
          <Banner />
          <RunHeader
            tool={toolName}
            description={toolDesc}
            cwd={result.cwd}
          />
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
      <Banner />
      <RunHeader
        tool="Simulation"
        description={`Recipe: ${result.recipeName}`}
        cwd={result.cwd}
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
      <Banner />
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
    ? 'To remove the CLI itself: npm uninstall -g @opensip-tools/cli'
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

