/**
 * Renderer signature alias (PR-3).
 *
 * The CLI handler dispatches to one of three renderers (table, json,
 * sarif) based on flags. Each is a pure function with this shape;
 * declaring `export const renderTable: Renderer = ...` makes drift
 * caught at typecheck rather than runtime.
 */

import type { CliOutput } from '@opensip-tools/contracts';
import type { Signal } from '@opensip-tools/core';

/** Context passed to every {@link Renderer}: cwd, tool name, command, and CLI output bundle. */
export interface RenderContext {
  readonly cwd: string;
  readonly tool: 'graph';
  readonly command: string;
  /** Used by JSON renderer to construct CliOutput. */
  readonly output?: CliOutput;
  /** Resolution tier of the catalog being rendered; surfaced into JSON. */
  readonly resolutionMode?: 'exact' | 'fast';
}

/** Pure signal-to-string renderer (table/json/sarif) selected by CLI flags. */
export type Renderer = (signals: readonly Signal[], context: RenderContext) => string;
