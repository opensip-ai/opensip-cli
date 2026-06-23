/**
 * Live-run chrome + per-phase frame bodies for {@link LiveRun}.
 */

import { Box, Static, Text } from 'ink';
import React from 'react';

import { Banner, UpdateHint, normalizeBannerSize } from './banner.js';
import { ErrorMessage } from './error-message.js';
import { LiveProgress } from './live-progress.js';
import { liveRunTable } from './live-run-table.js';
import { ProjectHeader } from './project-header.js';
import { renderToInk } from './render-to-ink.js';
import { RunFooterHints } from './run-footer-hints.js';
import { RunHeader } from './run-header.js';
import {
  DEFAULT_RUN_FOOTER_HINTS,
  shouldRenderRunFooterHints,
  shouldRenderRunUnitTable,
} from './run-render-policy.js';
import { RunSummary } from './run-summary.js';
import { RunTimingProvider } from './run-timing-provider.js';
import { viewFindingsGroups, viewVerboseLines } from './verbose-detail.js';

import type { LiveRunProps } from './live-run-types.js';
import type { ProgressCallback } from './progress-event.js';

const NO_PROGRESS: (cb: ProgressCallback) => void = () => {
  // loading phase — no event stream yet
};

function liveRunHeader(props: LiveRunProps): React.ReactElement | null {
  if (props.quiet) return null;
  const bannerSize = normalizeBannerSize(props.ui?.bannerSize);
  const showProjectHeader = bannerSize !== 'mini';
  const showHeader = props.showRunHeader !== false;

  const bannerBlock = (
    <>
      <Banner
        size={bannerSize}
        version={props.ui?.version}
        projectPath={props.projectPath}
        walkedUp={props.walkedUp}
        update={props.ui?.update}
      />
      {bannerSize === 'mini' && props.ui?.update !== undefined && <UpdateHint />}
      {showProjectHeader && props.projectPath !== undefined && (
        <ProjectHeader root={props.projectPath} walkedUp={props.walkedUp} />
      )}
    </>
  );

  const headerBlock =
    showHeader === true ? (
      <RunHeader
        tool={props.meta.title}
        description={props.meta.description}
        metadata={props.headerMetadata}
      />
    ) : null;

  if (props.staticChrome === true) {
    const items: ('banner' | 'header')[] = props.quiet ? [] : ['banner'];
    if (!props.quiet && showHeader) items.push('header');
    if (items.length === 0) return null;
    return (
      <Static items={items}>
        {(item) =>
          item === 'banner' ? (
            <React.Fragment key="banner">{bannerBlock}</React.Fragment>
          ) : (
            <React.Fragment key="header">{headerBlock}</React.Fragment>
          )
        }
      </Static>
    );
  }

  return (
    <>
      {bannerBlock}
      {headerBlock}
    </>
  );
}

function liveRunDoneBody(
  props: LiveRunProps,
  data: NonNullable<Extract<LiveRunProps['state'], { phase: 'done' }>['data']>,
): React.ReactElement {
  const renderPolicy = { verbose: props.verbose };
  const tableNode =
    !props.quiet && shouldRenderRunUnitTable(renderPolicy) && data.table !== undefined
      ? liveRunTable(data.table)
      : null;

  const summaryEl = (
    <RunSummary
      passed={data.summary.passed}
      errors={data.summary.errors}
      warnings={data.summary.warnings}
    />
  );
  const timedSummary =
    props.timer === undefined ? (
      summaryEl
    ) : (
      <RunTimingProvider timer={props.timer}>{summaryEl}</RunTimingProvider>
    );

  return (
    <Box flexDirection="column">
      {data.banner !== undefined && (
        <Box paddingLeft={2}>
          <Text dimColor>{data.banner}</Text>
        </Box>
      )}
      {props.verbose && data.verboseLines !== undefined && data.verboseLines.length > 0 && (
        <Box flexDirection="column" paddingTop={1}>
          {renderToInk(viewVerboseLines(data.verboseLines))}
        </Box>
      )}
      {props.verbose && data.verboseFindings !== undefined && data.verboseFindings.length > 0 && (
        <Box>{renderToInk(viewFindingsGroups(data.verboseFindings))}</Box>
      )}
      {tableNode !== null && (
        <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
          {renderToInk(tableNode)}
        </Box>
      )}
      {timedSummary}
      {!props.quiet && data.warnings !== undefined && data.warnings.length > 0 && (
        <Box flexDirection="column" paddingTop={1}>
          {data.warnings.map((w) => (
            <Text key={w} color="yellow">
              {w}
            </Text>
          ))}
        </Box>
      )}
      {!props.quiet && shouldRenderRunFooterHints(renderPolicy) && (
        <RunFooterHints hints={DEFAULT_RUN_FOOTER_HINTS} />
      )}
    </Box>
  );
}

export function liveRunBody(props: LiveRunProps): React.ReactElement {
  const header = liveRunHeader(props);
  const loadingSurface = props.loadingSurface ?? props.surface;

  switch (props.state.phase) {
    case 'loading': {
      if (props.loadingMessage !== undefined) {
        return (
          <Box flexDirection="column">
            {header}
            <Box paddingLeft={2} paddingTop={1}>
              <Text dimColor>{props.loadingMessage}</Text>
            </Box>
          </Box>
        );
      }
      return (
        <>
          {header}
          <Box paddingTop={1}>
            <LiveProgress surface={loadingSurface} subscribe={NO_PROGRESS} />
          </Box>
        </>
      );
    }

    case 'running': {
      return (
        <>
          {header}
          <LiveProgress surface={props.surface} subscribe={props.state.subscribe} />
        </>
      );
    }

    case 'done': {
      return (
        <Box flexDirection="column">
          {header}
          {props.state.subscribe !== undefined && (
            <LiveProgress surface={props.surface} subscribe={props.state.subscribe} />
          )}
          {liveRunDoneBody(props, props.state.data)}
        </Box>
      );
    }

    case 'error': {
      return (
        <Box flexDirection="column">
          {header}
          <ErrorMessage message={props.state.message} suggestion={props.state.suggestion} />
        </Box>
      );
    }
  }
}
