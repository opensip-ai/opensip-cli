/**
 * Cache invalidation per §6.2.
 *
 * v3: the catalog is content-keyed via three signals:
 *  1. language       — adapter id; mismatch invalidates immediately.
 *  2. cacheKey       — opaque per-adapter invalidation key; mismatch
 *                      invalidates (e.g. TS upgrade or tsconfig change).
 *  3. filesFingerprint — per-file mtime + ctime + size agreement; any source
 *                      file change re-runs stages 1+2.
 *
 * Per-file fingerprinting uses nanosecond mtime + ctime + size to keep the cost
 * low while detecting same-size rewrites whose mtime was restored.
 *
 * Wave 4 layered an "incremental" verdict on top: when language +
 * cacheKey agree but some files have changed metadata, the orchestrator
 * can re-walk only the changed files (plus their transitive edge-
 * dependents) instead of rebuilding everything. See `classifyCatalog`
 * and the orchestrator's incremental path.
 */

import { statSync } from 'node:fs';

import { logger } from '@opensip-cli/core';

import type { Catalog } from '../types.js';

/**
 * The current-run signals a cached {@link Catalog} is validated against:
 * the active adapter language, its opaque per-adapter cache key, and the current
 * source file set. {@link classifyCatalog} compares these against the cached
 * catalog to decide valid / incremental / invalid.
 */
export interface ValidationContext {
  readonly currentLanguage: string;
  readonly currentCacheKey: string;
  readonly currentFiles: readonly string[];
  /** Optional caller-captured snapshot used to bind cache classification to
   * the build that follows it. */
  readonly currentFilesFingerprint?: string;
}

/**
 * Wave 4 verdict — three states:
 *   - 'valid': cached catalog matches current file set on every axis;
 *     orchestrator returns it untouched.
 *   - 'incremental': language + cacheKey agree, but some files changed.
 *     `changedFiles` lists the absolute paths whose cached entries
 *     must be re-walked. Orchestrator builds the program over all
 *     current files and only walks/resolves the changed set.
 *   - 'invalid': structural mismatch (language, cacheKey, missing
 *     fingerprint). Orchestrator does a full rebuild.
 */
export type CatalogVerdict =
  | { readonly kind: 'valid' }
  | { readonly kind: 'incremental'; readonly changedFiles: readonly string[] }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Classify a cached catalog against the current run ({@link ValidationContext})
 * into a {@link CatalogVerdict}: `valid` (reuse as-is), `incremental` (reuse but
 * re-walk the listed changed files), or `invalid` (full rebuild). Language and
 * cache-key mismatches force `invalid`; otherwise the per-file fingerprint
 * decides between `valid` and `incremental`.
 */
export function classifyCatalog(cached: Catalog, ctx: ValidationContext): CatalogVerdict {
  if (cached.language !== ctx.currentLanguage) {
    logger.info({
      evt: 'graph.cache.invalidate.miss',
      module: 'graph:cache',
      reason: 'language-changed',
      cached: cached.language,
      current: ctx.currentLanguage,
    });
    return { kind: 'invalid', reason: 'language-changed' };
  }
  if (cached.cacheKey !== ctx.currentCacheKey) {
    logger.info({
      evt: 'graph.cache.invalidate.miss',
      module: 'graph:cache',
      reason: 'cache-key-changed',
      cached: cached.cacheKey,
      current: ctx.currentCacheKey,
    });
    return { kind: 'invalid', reason: 'cache-key-changed' };
  }
  const cachedFingerprint = (cached as { filesFingerprint?: string }).filesFingerprint;
  if (typeof cachedFingerprint !== 'string') {
    logger.info({
      evt: 'graph.cache.invalidate.miss',
      module: 'graph:cache',
      reason: 'no-fingerprint',
    });
    return { kind: 'invalid', reason: 'no-fingerprint' };
  }
  const currentFingerprint =
    ctx.currentFilesFingerprint ?? computeFilesFingerprint(ctx.currentFiles);
  if (cachedFingerprint === currentFingerprint) {
    return { kind: 'valid' };
  }
  const changedFiles = diffFingerprints(cachedFingerprint, currentFingerprint);
  logger.info({
    evt: 'graph.cache.invalidate.incremental',
    module: 'graph:cache',
    changedFiles: changedFiles.length,
  });
  return { kind: 'incremental', changedFiles };
}

/**
 * Compute a fingerprint over the project's source files. Uses nanosecond mtime,
 * ctime, and size per file plus the file count; cheap to compute and stable for
 * unchanged trees.
 */
export function computeFilesFingerprint(files: readonly string[]): string {
  const parts: string[] = [String(files.length)];
  for (const f of files) {
    try {
      const st = statSync(f, { bigint: true });
      parts.push(`${f}|${String(st.mtimeNs)}|${String(st.ctimeNs)}|${String(st.size)}`);
    } catch {
      parts.push(`${f}|missing`);
    }
  }
  return parts.join('\n');
}

/**
 * Diff two fingerprints (computed by `computeFilesFingerprint`) and
 * return the absolute file paths that differ. A file appears in the
 * result if it was added, removed, or had its mtime/ctime/size change. The
 * leading file-count line is ignored. Used by the incremental
 * rebuild path.
 */
export function diffFingerprints(
  cachedFingerprint: string,
  currentFingerprint: string,
): readonly string[] {
  const cachedMap = parseFilesFingerprint(cachedFingerprint);
  const currentMap = parseFilesFingerprint(currentFingerprint);
  const changed = new Set<string>();
  for (const [path, mark] of cachedMap) {
    const cur = currentMap.get(path);
    if (cur === undefined || cur !== mark) changed.add(path);
  }
  for (const [path] of currentMap) {
    if (!cachedMap.has(path)) changed.add(path);
  }
  return [...changed].sort();
}

/** Parse a files fingerprint into its absolute-path to stat-mark entries. */
export function parseFilesFingerprint(fingerprint: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const lines = fingerprint.split('\n');
  // Skip the leading file-count line.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (typeof line !== 'string' || line.length === 0) continue;
    const parsed = splitFingerprintLine(line);
    if (!parsed) continue;
    out.set(parsed.path, parsed.mark);
  }
  return out;
}

/**
 * Split one `computeFilesFingerprint` line into its path and stat-mark.
 * Lines are built as `${path}|${mtimeNs}|${ctimeNs}|${size}` (three trailing
 * numeric fields) or `${path}|missing`. The path itself is an absolute
 * filesystem path and MAY contain '|', so the split walks in from the END of
 * the line — never trust the first '|' as the path/mark boundary, or a
 * pipe-bearing path gets truncated and its edits silently stop invalidating
 * the cache.
 */
function splitFingerprintLine(
  line: string,
): { readonly path: string; readonly mark: string } | undefined {
  const lastPipe = line.lastIndexOf('|');
  if (lastPipe <= 0) return undefined;
  if (line.slice(lastPipe + 1) === 'missing') {
    return { path: line.slice(0, lastPipe), mark: 'missing' };
  }
  const secondPipe = line.lastIndexOf('|', lastPipe - 1);
  if (secondPipe <= 0) return undefined;
  const thirdPipe = line.lastIndexOf('|', secondPipe - 1);
  if (thirdPipe <= 0) return undefined;
  return { path: line.slice(0, thirdPipe), mark: line.slice(thirdPipe + 1) };
}
