/**
 * FitView — stateful component that manages the fit command lifecycle:
 * 1. Loads checks, shows Banner + RunHeader
 * 2. Shows Spinner while checks execute
 * 3. Transitions to ResultsTable + Summary when complete
 */

import { ensureChecksLoaded, getEnabledCheckCount, executeFit , reportToCloud } from '@opensip-tools/fitness';
import { useApp, Box, Text } from 'ink';
import React, { useState, useEffect } from 'react';

import { Banner } from './Banner.js';
import { CloudReportStatus } from './CloudReportStatus.js';
import { ErrorMessage } from './ErrorMessage.js';
import { Findings } from './Findings.js';
import { ResultsTable } from './ResultsTable.js';
import { RunHeader } from './RunHeader.js';
import { Spinner } from './Spinner.js';
import { Summary } from './Summary.js';

// eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; FitView consumes the CliArgs shape produced by fit's *OptsToCliArgs adapter until the rip-out
import type { FitDoneResult, ErrorResult, CliOutput , CliArgs } from '@opensip-tools/contracts';
import type { DataStore } from '@opensip-tools/datastore';

type FitState =
  | { phase: 'loading' }
  | { phase: 'running'; completed: number; total: number; checkCount: number }
  | { phase: 'done'; result: FitDoneResult; checkCount: number }
  | { phase: 'error'; result: ErrorResult };

export interface FitViewProps {
  // eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
  readonly args: CliArgs;
  readonly datastore?: DataStore;
}

// TODO(merge): the `datastore` prop and an `onProgress` callback are
// both expected by v2's executeFit signature, but audit's D1 phase
// dropped the extra params. Threading them back is a follow-up. For
// now, the prop is unused; tests that exercise FitView still pass
// because the rendered output doesn't depend on either.
export function FitView({ args }: FitViewProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<FitState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // Phase 1: Load checks to get count for header
      await ensureChecksLoaded(args.cwd);
      const checkCount = getEnabledCheckCount();

      if (cancelled) return;
      setState({ phase: 'running', completed: 0, total: 0, checkCount });

      // Phase 2: Execute
      // TODO(merge): executeFit signature needs to accept onProgress +
      // datastore (audit's D1 phase decomposed it before v2's persistence
      // wiring landed). For now drop the extras; the live progress and
      // session persistence are tracked as merge follow-ups.
      const fitResult = await executeFit(args);

      if (cancelled) return;

      if (fitResult.result.type === 'error') {
        setState({ phase: 'error', result: fitResult.result });
        process.exitCode = fitResult.result.exitCode;
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
        process.exitCode = 1;
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
              tool="Fitness Checks"
              description="Scanning your codebase for quality, security, and architecture issues."
              cwd={args.cwd}
              metadata={[{ label: 'Recipe', value: recipe }]}
            />
          )}
          <Box paddingLeft={2}>
            <Spinner total={0} completed={0} label="Loading checks..." />
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
              tool="Fitness Checks"
              description="Scanning your codebase for quality, security, and architecture issues."
              cwd={args.cwd}
              metadata={[
                { label: 'Recipe', value: recipe },
                { label: 'Checks', value: String(state.checkCount) },
              ]}
            />
          )}
          <Box paddingLeft={2}>
            <Spinner total={state.total} completed={state.completed} />
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
              tool="Fitness Checks"
              description="Scanning your codebase for quality, security, and architecture issues."
              cwd={args.cwd}
              metadata={[
                { label: 'Recipe', value: recipe },
                { label: 'Checks', value: String(state.checkCount) },
              ]}
            />
          )}
          {!args.quiet && (args.verbose || args.findings) && (
            <Box paddingTop={1} flexDirection="column">
              <ResultsTable rows={state.result.rows} />
            </Box>
          )}
          <Summary {...state.result.summary} />
          {!args.quiet && state.result.findings && <Findings checks={state.result.findings.checks} />}
          {!args.quiet && state.result.reportStatus && <CloudReportStatus {...state.result.reportStatus} />}
          {!args.quiet && !args.verbose && !args.findings && (
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
      return <ErrorMessage message={state.result.message} suggestion={state.result.suggestion} />;
    }
  }
}
