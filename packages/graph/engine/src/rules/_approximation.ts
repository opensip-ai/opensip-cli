/**
 * Shared helper for rules that depend on edge completeness.
 *
 * On a fast (syntactic) catalog, call edges are approximate: a missing
 * edge can make an absence-based rule (orphan detection, test-only
 * reachability) emit a false positive — a function looks unreachable
 * only because its sole caller's edge wasn't resolved. Rather than
 * silently emitting findings that read as exact, such rules annotate
 * their findings so a reader on a fast catalog knows the caveat.
 *
 * Structural rules (duplicated body, always-throws) don't depend on
 * edges and don't use this.
 */

import type { Catalog } from '../types.js';

/** True when the catalog was produced by the approximate (fast) tier. */
export function isApproximateCatalog(catalog: Catalog): boolean {
  return catalog.resolutionMode === 'fast';
}

/**
 * Suffix appended to an edge-dependent finding's message on a fast
 * catalog. Empty string for exact catalogs, so the common case is
 * unchanged and the call site reads as `message + approximateSuffix(catalog)`.
 */
export function approximateSuffix(catalog: Catalog): string {
  return isApproximateCatalog(catalog)
    ? ' [approximate: based on fast-mode syntactic edges — a missing edge may make this a false positive; confirm with --resolution exact]'
    : '';
}
