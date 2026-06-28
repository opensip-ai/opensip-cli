/**
 * Catalog freshness mapping (ADR-0084).
 *
 * Reuses the graph engine's `classifyCatalog` verdict (never a filesystem mtime
 * heuristic outside the engine) and maps the `CatalogVerdict` to the agent-facing
 * {@link Freshness} DTO. Building the `ValidationContext` from the working tree
 * (current file set + adapter cache key) is the server's wiring concern (Phase 3),
 * supplied to the SQLite port as an injected provider — this module is the pure
 * verdict→DTO mapping.
 *
 * Missing catalog ⇒ `{ fresh: false, reason: 'missing' }` (no auto-build). A
 * loaded catalog whose freshness cannot be verified (no context provider wired)
 * is reported `fresh: true` with its `builtAt` — matching `opensip graph lookup`,
 * which serves the persisted catalog without re-verification.
 */

import { classifyCatalog } from '@opensip-cli/graph/internal';

import type { Freshness } from './symbol-dto.js';
import type { Catalog } from '@opensip-cli/graph';
import type { CatalogVerdict, ValidationContext } from '@opensip-cli/graph/internal';

/** Freshness for an absent catalog — empty data, explicit refresh required. */
export function missingFreshness(): Freshness {
  return { fresh: false, reason: 'missing' };
}

/** Freshness for a loaded catalog whose staleness was not verified (no context). */
export function unverifiedFreshness(builtAt: string): Freshness {
  return { fresh: true, builtAt };
}

/** Map a {@link CatalogVerdict} (+ the served catalog's `builtAt`) to {@link Freshness}. */
export function freshnessFromVerdict(verdict: CatalogVerdict, builtAt: string): Freshness {
  switch (verdict.kind) {
    case 'valid': {
      return { fresh: true, builtAt };
    }
    case 'incremental': {
      return {
        fresh: false,
        builtAt,
        reason: `stale: ${String(verdict.changedFiles.length)} file(s) changed since build`,
      };
    }
    case 'invalid': {
      return { fresh: false, builtAt, reason: `stale: ${verdict.reason}` };
    }
  }
}

/** Classify a loaded catalog against the current working-tree context. */
export function classifyFreshness(catalog: Catalog, ctx: ValidationContext): Freshness {
  return freshnessFromVerdict(classifyCatalog(catalog, ctx), catalog.builtAt);
}
