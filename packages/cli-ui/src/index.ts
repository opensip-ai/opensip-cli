/**
 * @opensip-tools/cli-ui — shared Ink/React presentational primitives for
 * OpenSIP Tools CLI tools.
 *
 * Tools that ship an Ink live view (fitness, graph, future audit/lint/etc.)
 * import from this package instead of duplicating banner/spinner/header
 * code in their own runner files. The CLI's static-render path (App.tsx)
 * imports the same primitives so the live view and the post-run summary
 * look consistent.
 *
 * This package depends on `ink` and `react` only; no opensip-tools deps,
 * no Node-runtime side-effects beyond the theme's terminal-capability
 * detection. Safe to import from any Layer 3 tool package.
 */

export {
  Banner,
  UpdateHint,
  normalizeBannerSize,
  type BannerSize,
  type BannerProps,
} from './banner.js';
export { ErrorMessage, type ErrorMessageProps } from './error-message.js';
export {
  ProjectHeader,
  formatProjectHeader,
  viewProjectHeader,
  type ProjectHeaderInput,
} from './project-header.js';
export { RunHeader, type RunHeaderProps, type RunHeaderMeta } from './run-header.js';
export { RunSummary, viewRunSummary, type RunSummaryProps } from './run-summary.js';
export {
  RunFooterHints,
  viewFooterHints,
  type RunFooterHint,
  type RunFooterHintsProps,
} from './run-footer-hints.js';
export {
  sortFitRowPriority,
  parseValidatedCount,
  formatValidatedColumn,
  type FitRowSortKey,
} from './fit-table-format.js';
export { Spinner, type SpinnerProps, useSpinner, useStandaloneSpinner } from './spinner.js';
export { ClockProvider, type ClockProviderProps, useClock, useTick } from './clock.js';
export { formatDuration } from './format-duration.js';
export { LiveProgress, useProgressState, type LiveProgressProps } from './live-progress.js';
export type {
  ProgressEvent,
  ProgressCallback,
  ProgressShape,
  ProgressStageDescriptor,
  ProgressSurface,
} from './progress-event.js';
export {
  type ViewNode,
  type Span,
  type Tone,
  type HintItem,
  type TableColumnSpec,
  text,
  line,
  group,
  viewTable,
} from './view-model.js';
export {
  viewVerboseLines,
  viewFindingsGroups,
  viewVerboseHint,
  VERBOSE_DETAIL_HINT,
  type FindingLineView,
  type FindingGroupView,
} from './verbose-detail.js';
export { renderToText } from './render-to-text.js';
export { renderToInk } from './render-to-ink.js';
export {
  DEFAULT_THEME,
  ThemeContext,
  ThemeProvider,
  type Theme,
  type ThemeProviderProps,
  type TerminalCapabilities,
  detectTerminalCapabilities,
  useTheme,
} from './theme.js';
