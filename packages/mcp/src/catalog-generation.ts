/**
 * Immutable catalog generation (ADR-0084).
 *
 * The server holds EXACTLY ONE generation in memory at a time: an immutable
 * `{ catalog, indexes, builtAt }` snapshot. Reads pin the current generation;
 * `refresh()` builds the next and swaps the reference atomically on completion
 * (a single synchronous assignment after the async rebuild resolves), so
 * in-flight reads keep the old generation until the swap — TOCTOU-safe. The
 * `Indexes` are derived per generation via the graph engine's canonical
 * `buildIndexes`, never persisted.
 */

import { buildIndexes } from '@opensip-cli/graph/internal';

import type { Catalog, Indexes } from '@opensip-cli/graph';

/** One immutable in-memory snapshot of the served catalog + its derived indexes. */
export interface CatalogGeneration {
  readonly catalog: Catalog;
  readonly indexes: Indexes;
  /** ISO timestamp the catalog was built at (its `builtAt`). */
  readonly builtAt: string;
}

/** Derive a generation snapshot from a loaded catalog (builds adjacency once). */
export function createGeneration(catalog: Catalog): CatalogGeneration {
  return {
    catalog,
    indexes: buildIndexes(catalog),
    builtAt: catalog.builtAt,
  };
}
