/** Bounded explicit-file impact projection over the canonical contracts compute. */

import {
  ComputeImpactCancelledError,
  ComputeImpactIndexGenerationMismatchError,
  type ComputeImpactChangedFileEntry,
  type ComputeImpactIndex,
  type ImpactComputation,
  type ImpactTrust,
} from '@opensip-cli/contracts';
import { err, ok, type Result } from '@opensip-cli/core';
import { buildComputeImpactIndex, computeImpactAsync } from '@opensip-cli/shared-analysis';

import { compareCodePointStrings } from '../code-point-order.js';

import { makeFacet, rollupFacets, UNREQUESTED_FACET } from './bounded-view.js';

import type { GraphReadFacetCoverage } from './query-contracts.js';
import type { Catalog, GraphReadError } from './types.js';

export const MAX_IMPACT_VIEW_FILES = 128;
export const MAX_IMPACT_VIEW_ROWS = 500;

/** Bounded traversal, projection, index-reuse, and cancellation controls for an impact read. */
export interface ImpactViewOptions {
  readonly maxDepth?: number;
  readonly top?: number;
  readonly changedFileEntries?: readonly ComputeImpactChangedFileEntry[];
  readonly index?: ComputeImpactIndex;
  readonly signal?: AbortSignal;
}

/** Canonical impact computation plus explicit request/coverage context. */
export interface GraphImpactView extends ImpactComputation {
  readonly requestedFiles: readonly string[];
  readonly matchedFiles: readonly string[];
  readonly unmatchedFiles: readonly string[];
  /** Alias retained for consumers that project trust separately from rows. */
  readonly trust: ImpactTrust;
  readonly coverage: GraphReadFacetCoverage;
}

function impactError(code: string, message: string): GraphReadError {
  return { code, operation: 'analysis', message };
}

function normalizeProjectFile(value: string): string | undefined {
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized.length === 0 ||
    normalized.length > 1024 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    /\p{Cc}/u.test(normalized)
  ) {
    return undefined;
  }
  const parts = normalized.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
    ? normalized
    : undefined;
}

function normalizeFiles(files: readonly string[]): Result<readonly string[], GraphReadError> {
  if (files.length === 0 || files.length > MAX_IMPACT_VIEW_FILES) {
    return err(
      impactError(
        'GRAPH.READ.IMPACT_FILES_CAP',
        `Impact reads require 1-${String(MAX_IMPACT_VIEW_FILES)} project-relative files`,
      ),
    );
  }
  const normalized = new Set<string>();
  for (const file of files) {
    const candidate = normalizeProjectFile(file);
    if (candidate === undefined) {
      return err(
        impactError(
          'GRAPH.READ.IMPACT_FILE_INVALID',
          'Impact files must be bounded project-relative POSIX paths',
        ),
      );
    }
    normalized.add(candidate);
  }
  return ok([...normalized].sort(compareCodePointStrings));
}

function boundedTop(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_IMPACT_VIEW_ROWS;
  return Math.min(Math.max(0, Math.trunc(value)), MAX_IMPACT_VIEW_ROWS);
}

/** Build one bounded impact answer without filesystem or persistence access. */
export async function buildImpactView(
  catalog: Catalog,
  files: readonly string[],
  options: ImpactViewOptions = {},
): Promise<Result<GraphImpactView, GraphReadError>> {
  const normalized = normalizeFiles(files);
  if (!normalized.ok) return normalized;
  try {
    const index = options.index ?? (await buildComputeImpactIndex(catalog, options.signal));
    const requestedFiles = normalized.value;
    const matchedFiles = requestedFiles.filter((file) => index.catalogFiles.has(file));
    const unmatchedFiles = requestedFiles.filter((file) => !index.catalogFiles.has(file));
    const result = await computeImpactAsync(catalog, requestedFiles, {
      maxDepth: options.maxDepth,
      top: boundedTop(options.top),
      changedFileEntries: options.changedFileEntries,
      index,
      signal: options.signal,
    });
    const inventoryReasons = new Set<string>();
    if (unmatchedFiles.length > 0) inventoryReasons.add('impact-inventory-unmatched');
    const projectionReasons = new Set<string>();
    if (result.truncated) projectionReasons.add('impact-projection-cap');
    if (
      result.trust.uncertainties.some(
        (uncertainty) => uncertainty.code === 'impact-malformed-row-omitted',
      )
    ) {
      projectionReasons.add('impact-malformed-row-omitted');
    }
    return ok({
      ...result,
      requestedFiles,
      matchedFiles,
      unmatchedFiles,
      coverage: rollupFacets({
        inventory: makeFacet(true, inventoryReasons),
        evidence: UNREQUESTED_FACET,
        grouping: UNREQUESTED_FACET,
        projection: makeFacet(true, projectionReasons),
      }),
    });
  } catch (error) {
    if (error instanceof ComputeImpactCancelledError) {
      return err(impactError('GRAPH.READ.IMPACT_CANCELLED', 'Graph impact read was cancelled'));
    }
    if (error instanceof ComputeImpactIndexGenerationMismatchError) {
      return err(
        impactError(
          'GRAPH.READ.IMPACT_INDEX_GENERATION_MISMATCH',
          'Impact index belongs to a different graph catalog generation',
        ),
      );
    }
    return err(impactError('GRAPH.READ.IMPACT_FAILED', 'Failed to build graph impact projection'));
  }
}
