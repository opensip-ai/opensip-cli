import { ephemeralProjectCacheKey } from '@opensip-cli/core';

import { fromGraphReadError, readError, type McpReadError } from './mcp-error.js';

import type { CatalogGeneration } from './catalog-generation-model.js';
import type { GraphReadReason } from '@opensip-cli/graph/read';

export type GenerationLog = (
  evt: string,
  fields: Record<string, string | number | boolean | undefined>,
) => void;

/** Emit one generation load/swap/removal transition without exposing catalog data. */
export function logGenerationTransition(
  log: GenerationLog | undefined,
  prior: CatalogGeneration | undefined,
  next: CatalogGeneration | undefined,
  durationMs: number,
): void {
  if (prior?.key === next?.key) return;
  if (next === undefined) {
    if (prior !== undefined) {
      log?.('mcp.graph.generation.removed', {
        priorAvailable: true,
        durationMs,
      });
    }
    return;
  }
  log?.(prior === undefined ? 'mcp.graph.generation.loaded' : 'mcp.graph.generation.swapped', {
    source: next.source,
    mode: next.catalog.resolutionMode ?? 'exact',
    priorAvailable: prior !== undefined,
    durationMs,
  });
}

/** Map graph-read failures at the generation load boundary. */
export function mapCatalogLoadError(error: {
  code: GraphReadReason;
  message: string;
}): McpReadError {
  return fromGraphReadError({
    code: error.code,
    operation: 'catalog-generation',
    message: error.message,
  });
}

/** Build the stable, privacy-safe refresh failure diagnostic. */
export function graphRefreshFailure(input: {
  readonly cause: McpReadError | undefined;
  readonly currentGeneration: CatalogGeneration | undefined;
  readonly failedPhase: string;
  readonly projectRoot: string;
  readonly retainedGeneration: CatalogGeneration | undefined;
  readonly started: number;
}): McpReadError {
  return readError('graph-refresh-failed', 'Graph refresh failed due to an infrastructure error.', {
    failedPhase: input.failedPhase,
    outcome: 'failed',
    durationMs: Date.now() - input.started,
    priorGenerationAvailable: input.retainedGeneration !== undefined,
    projectKey: ephemeralProjectCacheKey(input.projectRoot),
    priorGenerationKey: input.retainedGeneration?.key ?? 'missing',
    currentGenerationKey: input.currentGeneration?.key ?? 'missing',
    ...(input.cause?.code === undefined ? {} : { causeCode: input.cause.code }),
  });
}
