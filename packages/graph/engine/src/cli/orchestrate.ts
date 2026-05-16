/**
 * Pipeline orchestrator — threads stages 0–5 together.
 *
 * The single module that imports from multiple stages. Per spec §5,
 * the orchestrator is straight-line code; every interesting decision
 * happens inside one of the stages. P0 ships a no-op shape; subsequent
 * phases fill it in.
 */

import type { Catalog, GraphConfig, Indexes, ResolutionStats } from '../types.js';
import type { Signal } from '@opensip-tools/core';


export interface RunGraphInput {
  readonly cwd: string;
  readonly noCache?: boolean;
  readonly config?: GraphConfig;
}

export interface RunGraphResult {
  readonly catalog: Catalog | null;
  readonly indexes: Indexes | null;
  readonly signals: readonly Signal[];
  readonly resolutionStats: ResolutionStats | null;
  readonly cacheHit: boolean;
}

/**
 * Run the pipeline end-to-end. P0 returns an empty result; later
 * phases populate fields as their stages come online (cache I/O makes
 * the function genuinely async at P6).
 */
// eslint-disable-next-line @typescript-eslint/require-await -- P0 skeleton; cache I/O lands in P6
export async function runGraph(_input: RunGraphInput): Promise<RunGraphResult> {
  return {
    catalog: null,
    indexes: null,
    signals: [],
    resolutionStats: null,
    cacheHit: false,
  };
}
