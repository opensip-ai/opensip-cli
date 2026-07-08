/**
 * Live-run chrome + per-phase frame bodies for {@link LiveRun}.
 */

import { Box, Static, Text } from 'ink';
import React from 'react';

import { Banner, UpdateHint, normalizeBannerSize } from './banner.js';
import { ErrorMessage } from './error-message.js';
import { LiveProgress } from './live-progress.js';
import { liveRunTable } from './live-run-table.js';
import { renderToInk } from './render-to-ink.js';
import { viewResultSummary } from './result-summary.js';
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
      {props.ui?.update !== undefined && <UpdateHint />}
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

  // Banner rendering is shell-owned and IDENTICAL for every tool — no tool
  // opts in or out. The banner is immutable chrome, so it is always rendered
  // through a single <Static>: Ink prints it exactly once and never erases or
  // redraws it. A banner left in the dynamic frame is re-emitted on every
  // progress tick and leaves a duplicate behind whenever Ink miscounts the
  // frame height across a phase transition (the duplicate-banner bug).
  //
  // The RunHeader rides in the dynamic frame (below the static banner) so
  // stream-driven header metadata — e.g. fit's live check counter, updated on
  // every progress event — renders in place. Immutable headers (sim/graph/
  // yagni) simply redraw to the same content; the header is small enough that
  // in-place redraw is free of the mis-erase that plagued the tall banner.
  //
  // Exactly ONE <Static> is mounted (the banner): Ink does not reliably
  // support multiple concurrent <Static> instances — a second one suppresses
  // the first's output.
  return (
    <>
      <Static items={['banner']}>
        {() => <React.Fragment key="banner">{bannerBlock}</React.Fragment>}
      </Static>
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
      {...(data.summary.faulted === undefined ? {} : { faulted: data.summary.faulted })}
      errors={data.summary.errors}
      warnings={data.summary.warnings}
      {...(data.summary.durationMs === undefined ? {} : { durationMs: data.summary.durationMs })}
    />
  );
  // Compact (non-verbose) surface: the attention-only unit bullets (failed +
  // faulted, with finding locations). The verbose surface shows the full table
  // instead, so this is suppressed there to avoid duplicating the per-unit view.
  const attentionNode =
    !props.quiet && !props.verbose && data.attention !== undefined
      ? viewResultSummary({ counts: data.attention.counts, items: data.attention.items })
      : null;
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
      {!props.quiet &&
        props.verbose &&
        data.verboseLines !== undefined &&
        data.verboseLines.length > 0 && (
          <Box flexDirection="column" paddingTop={1}>
            {renderToInk(viewVerboseLines(data.verboseLines))}
          </Box>
        )}
      {!props.quiet &&
        props.verbose &&
        data.verboseFindings !== undefined &&
        data.verboseFindings.length > 0 && (
          <Box>{renderToInk(viewFindingsGroups(data.verboseFindings))}</Box>
        )}
      {/* Verbose-only tool-specific detail (e.g. the suite's per-step + risk
          tables) — additive, above the standard summary. */}
      {!props.quiet && props.verbose && data.verboseExtra !== undefined && (
        <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
          {renderToInk(data.verboseExtra)}
        </Box>
      )}
      {tableNode !== null && (
        <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
          {renderToInk(tableNode)}
        </Box>
      )}
      {attentionNode !== null && (
        <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
          {renderToInk(attentionNode)}
        </Box>
      )}
      {timedSummary}
      {/* One additive line under the summary headline, on every surface (e.g.
          the suite's review verdict). */}
      {!props.quiet && data.summaryNote !== undefined && (
        <Box paddingLeft={2}>{renderToInk(data.summaryNote)}</Box>
      )}
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
        // Root element type must match the other phases (`<Box
        // flexDirection="column">`). A Fragment root here would make React
        // remount the whole subtree on the loading→running transition, which
        // resets Ink's <Static> "already-printed" count and reprints the
        // banner (duplicate-banner bug).
        <Box flexDirection="column">
          {header}
          <Box paddingTop={1}>
            <LiveProgress surface={loadingSurface} subscribe={NO_PROGRESS} />
          </Box>
        </Box>
      );
    }

    case 'running': {
      return (
        <Box flexDirection="column">
          {header}
          <LiveProgress surface={props.surface} subscribe={props.state.subscribe} />
        </Box>
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
