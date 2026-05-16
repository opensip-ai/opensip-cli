/**
 * Stage 3 — Index build (skeleton; implemented in P4).
 *
 * Pure linear scans over the catalog producing O(1) lookups. No TS,
 * no AST, no filesystem. Data → data.
 */

import type { Catalog, Indexes } from '../types.js';

export function buildIndexes(_catalog: Catalog): Indexes {
  throw new Error('buildIndexes: not implemented (Phase P4).');
}
