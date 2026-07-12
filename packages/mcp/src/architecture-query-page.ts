/** Composite cursor state for independently paged architecture row families. */

import { err, ok, type Result } from '@opensip-cli/core';
import {
  compareCodePointStrings,
  continuationToken,
  hotspotStableKey,
  packageEdgeStableKey,
  type ArchitectureView,
} from '@opensip-cli/graph/read';

import { readError, type McpReadError } from './mcp-error.js';

const CURSOR_INVALID = 'cursor-invalid';

export interface ArchitectureCursorState {
  readonly packageEdgeKey?: string;
  readonly hotspotKey?: string;
  readonly packageEdgesDone: boolean;
  readonly hotspotsDone: boolean;
}

export function decodeArchitectureCursorState(
  value: string | undefined,
): Result<ArchitectureCursorState, McpReadError> {
  if (value === undefined) return ok({ packageEdgesDone: false, hotspotsDone: false });
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return err(readError(CURSOR_INVALID, 'Architecture cursor state is malformed.'));
    }
    const state = parsed as Record<string, unknown>;
    const keys = Object.keys(state).sort(compareCodePointStrings);
    if (keys.some((key) => !['h', 'hd', 'p', 'pd'].includes(key))) {
      return err(readError(CURSOR_INVALID, 'Architecture cursor state has unknown fields.'));
    }
    if (typeof state.pd !== 'boolean' || typeof state.hd !== 'boolean') {
      return err(readError(CURSOR_INVALID, 'Architecture cursor state is incomplete.'));
    }
    if (
      (state.p !== undefined && (typeof state.p !== 'string' || state.p.length === 0)) ||
      (state.h !== undefined && (typeof state.h !== 'string' || state.h.length === 0))
    ) {
      return err(readError(CURSOR_INVALID, 'Architecture cursor keys are malformed.'));
    }
    return ok({
      packageEdgesDone: state.pd,
      hotspotsDone: state.hd,
      ...(state.p === undefined ? {} : { packageEdgeKey: state.p }),
      ...(state.h === undefined ? {} : { hotspotKey: state.h }),
    });
  } catch {
    return err(readError(CURSOR_INVALID, 'Architecture cursor state could not be decoded.'));
  }
}

/** Return compact row-family continuation identities, or undefined when both ended. */
export function nextArchitectureAfterKey(
  prior: ArchitectureCursorState,
  view: ArchitectureView,
): string | undefined {
  const edgesSelected = view.packageEdges !== undefined;
  const hotspotsSelected = view.hotspots !== undefined;
  // Unselected families are immediately "done" and never contribute cursor state.
  const lastEdge = view.packageEdges?.at(-1);
  const lastHotspot = view.hotspots?.at(-1);
  const packageEdgesDone =
    !edgesSelected || prior.packageEdgesDone || !view.packageEdgesHasMore;
  const hotspotsDone = !hotspotsSelected || prior.hotspotsDone || !view.hotspotsHasMore;
  if (packageEdgesDone && hotspotsDone) return undefined;
  const packageEdgeKey =
    !edgesSelected || lastEdge === undefined
      ? prior.packageEdgeKey
      : continuationToken(packageEdgeStableKey(lastEdge));
  const hotspotKey =
    !hotspotsSelected || lastHotspot === undefined
      ? prior.hotspotKey
      : continuationToken(hotspotStableKey(lastHotspot));
  return JSON.stringify({
    pd: packageEdgesDone,
    hd: hotspotsDone,
    ...(packageEdgeKey === undefined ? {} : { p: packageEdgeKey }),
    ...(hotspotKey === undefined ? {} : { h: hotspotKey }),
  });
}
