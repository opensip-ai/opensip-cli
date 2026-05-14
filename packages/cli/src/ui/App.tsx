/**
 * App — top-level Ink component that dispatches on CommandResult.type.
 */

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
import { PluginFeedback, type PluginAction } from './components/PluginFeedback.js';
import { RecipeList } from './components/RecipeList.js';
import { ResultsTable } from './components/ResultsTable.js';
import { RunHeader } from './components/RunHeader.js';
import { Summary } from './components/Summary.js';
import { useTheme } from './theme.js';

import type { CommandResult } from '@opensip-tools/cli-shared';

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

    case 'plugin': {
      return <PluginFeedback action={toPluginAction(result)} />;
    }

    case 'clear-done': {
      return (
        <Box flexDirection="column">
          <Banner />
          <Box paddingLeft={2} paddingTop={1}>
            {result.action === 'empty' && <Text dimColor>No session data to clear.</Text>}
            {result.action === 'cancelled' && <Text dimColor>Cancelled. No data was deleted.</Text>}
            {result.action === 'done' && (
              <Text>
                <Text color={useTheme().success}>{'\u2713'}</Text>
                {' '}{result.deletedCount} session{result.deletedCount === 1 ? '' : 's'} deleted.
              </Text>
            )}
          </Box>
        </Box>
      );
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

/** Map PluginResult to the PluginAction shape expected by PluginFeedback */
function toPluginAction(result: CommandResult & { type: 'plugin' }): PluginAction {
  if (result.action === 'list') {
    return {
      type: 'list',
      plugins: (result.plugins as { domain: string; namespace: string; pluginType: 'package' | 'file' }[]) ?? [],
      totalCount: (result.totalCount as number) ?? 0,
    };
  }
  if (result.action === 'install') {
    return {
      type: 'install',
      packageName: (result.packageName as string) ?? '',
      success: (result.success as boolean) ?? false,
      error: result.error as string | undefined,
    };
  }
  // remove
  return {
    type: 'remove',
    packageName: (result.packageName as string) ?? '',
    success: (result.success as boolean) ?? false,
    error: result.error as string | undefined,
  };
}
