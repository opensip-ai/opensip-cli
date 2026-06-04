/**
 * Renderer signature alias (PR-3).
 *
 * A pure `(signals, context) => string` renderer selected by CLI flags.
 * Post-ADR-0011 (Phase 5) the json/sarif renderers moved out (json → the
 * shared `formatSignalJson` via `cli.emitEnvelope`; sarif → the root's
 * `cli.writeSarif` / `--report-to`). `renderTable` is the remaining
 * Renderer-shaped helper; declaring `export const renderTable: Renderer = ...`
 * keeps drift caught at typecheck rather than runtime.
 */

import type { Signal } from '@opensip-tools/core';

/** Context passed to a {@link Renderer}: cwd, tool name, command, and catalog tier. */
export interface RenderContext {
  readonly cwd: string;
  readonly tool: 'graph';
  readonly command: string;
  /** Resolution tier of the catalog being rendered. */
  readonly resolutionMode?: 'exact' | 'fast';
}

/** Pure signal-to-string renderer selected by CLI flags. */
export type Renderer = (signals: readonly Signal[], context: RenderContext) => string;
