/**
 * Stage 2 — Edge resolution (skeleton; implemented in P2/P3).
 *
 * Walks every function's body, finds call sites, resolves each to a
 * list of catalog entries (by bodyHash), and appends edges to each
 * FunctionOccurrence's calls[].
 */

import type { Catalog, ResolutionStats } from '../types.js';
import type ts from 'typescript';


export interface EdgeResolutionInput {
  readonly catalog: Catalog;
  readonly program: ts.Program;
  readonly projectDirAbs: string;
}

export interface EdgeResolutionOutput {
  readonly catalog: Catalog;
  readonly resolutionStats: ResolutionStats;
}

export function resolveEdges(_input: EdgeResolutionInput): EdgeResolutionOutput {
  throw new Error('resolveEdges: not implemented (Phase P2/P3).');
}
