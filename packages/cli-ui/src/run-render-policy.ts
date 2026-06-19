/**
 * Platform-owned run rendering policy.
 *
 * Tools provide run data (`SignalEnvelope`, optional verbose detail, optional
 * banners) and live progress events. They should not each decide which surfaces
 * appear by default. This module centralizes those decisions for both the static
 * renderer and tool-owned live runners:
 *
 *   - default fresh run: compact summary + footer, no per-unit table
 *   - verbose/detail/replay: detailed body/table surfaces may render
 */

import { VERBOSE_DETAIL_HINT } from './verbose-detail.js';

import type { HintItem } from './view-model.js';

export interface RunRenderPolicyInput {
  /** True for an explicit `--verbose` run. */
  readonly verbose?: boolean;
  /** True for an explicit inspection/detail surface. */
  readonly detail?: boolean;
  /** True for session replay surfaces. */
  readonly replay?: boolean;
}

function isDetailSurface(input: RunRenderPolicyInput): boolean {
  return input.verbose === true || input.detail === true || input.replay === true;
}

/** Per-unit result tables are detailed surfaces, never default fresh-run output. */
export function shouldRenderRunUnitTable(input: RunRenderPolicyInput): boolean {
  return isDetailSurface(input);
}

/** Default footer hints are for compact fresh runs, not verbose/detail/replay. */
export function shouldRenderRunFooterHints(input: RunRenderPolicyInput): boolean {
  return !isDetailSurface(input);
}

/** Canonical report hint paired with the verbose hint on compact fresh runs. */
export const REPORT_HINT: HintItem = {
  text: 'opensip report for HTML report',
  bold: ['opensip report'],
};

/** Canonical footer hints for a compact non-verbose fresh run. */
export const DEFAULT_RUN_FOOTER_HINTS: readonly HintItem[] = [VERBOSE_DETAIL_HINT, REPORT_HINT];
