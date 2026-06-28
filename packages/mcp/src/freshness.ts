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

/**
 * Build the working-tree {@link ValidationContext} a real staleness check needs,
 * derived from the catalog's OWN recorded inputs (Task 4.4).
 *
 * A fully-correct context (the one `runGraph`/the cache path builds) requires
 * re-running discovery + the adapter `cacheKey` over the live tree. We implement
 * the closest correct subset that needs no engine re-entry: the catalog persists
 * its `filesFingerprint` (`<count>\n<path>|<mtime>|<size>` per file), so we
 * recover the EXACT tracked file set (in the recorded order) and echo the
 * catalog's own `language`/`cacheKey`. `classifyCatalog` then re-stats those
 * files and recomputes the fingerprint — so any **mutated or deleted tracked
 * file** flips the verdict to stale (`fresh === false`), which is what Phase 7
 * asserts.
 *
 * Documented approximation: a brand-new source file (absent from the recorded
 * set) is NOT detected as a staleness trigger without re-running discovery; and
 * a language/tsconfig change is not detected (we echo the cached key rather than
 * recomputing it). Those are catalog-additive changes the explicit `refresh_graph`
 * op resolves. Mutations/deletions of tracked files — the common drift — ARE
 * detected. Returns `undefined` when the catalog carries no fingerprint (older
 * builds), leaving the port on its unverified-fresh fallback.
 */
export function workingTreeContextFromCatalog(catalog: Catalog): ValidationContext | undefined {
  const fingerprint = (catalog as { filesFingerprint?: string }).filesFingerprint;
  if (typeof fingerprint !== 'string') return undefined;
  const currentFiles = filesFromFingerprint(fingerprint);
  if (currentFiles.length === 0) return undefined;
  return {
    currentLanguage: catalog.language,
    currentCacheKey: catalog.cacheKey,
    currentFiles,
  };
}

/** Recover the tracked file paths (in order) from a `computeFilesFingerprint` string. */
function filesFromFingerprint(fingerprint: string): string[] {
  const lines = fingerprint.split('\n');
  const files: string[] = [];
  // Line 0 is the leading file-count; each subsequent line is `path|mtime|size`.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (typeof line !== 'string' || line.length === 0) continue;
    const pipe = line.indexOf('|');
    files.push(pipe === -1 ? line : line.slice(0, pipe));
  }
  return files;
}
