/**
 * Cache invalidation per §6.2.
 *
 * v3: the catalog is content-keyed via three signals:
 *  1. language       — adapter id; mismatch invalidates immediately.
 *  2. cacheKey       — opaque per-adapter invalidation key; mismatch
 *                      invalidates (e.g. TS upgrade or tsconfig change).
 *  3. filesFingerprint — per-file mtime + size agreement; any source
 *                      file change re-runs stages 1+2.
 *
 * Per-file fingerprinting uses mtime + size to keep the cost low.
 *
 * Wave 4 layered an "incremental" verdict on top: when language +
 * cacheKey agree but some files have changed mtimes, the orchestrator
 * can re-walk only the changed files (plus their transitive edge-
 * dependents) instead of rebuilding everything. See `classifyCatalog`
 * and the orchestrator's incremental path.
 */

import { statSync } from 'node:fs';

import { logger } from '@opensip-tools/core';

import type { Catalog } from '../types.js';

export interface ValidationContext {
  readonly currentLanguage: string;
  readonly currentCacheKey: string;
  readonly currentFiles: readonly string[];
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
  const currentFingerprint = computeFilesFingerprint(ctx.currentFiles);
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
 * Compute a fingerprint over the project's source files. Uses mtime
 * (nanosecond resolution) per file plus the file count; cheap to
 * compute and stable for unchanged trees.
 */
export function computeFilesFingerprint(files: readonly string[]): string {
  const parts: string[] = [String(files.length)];
  for (const f of files) {
    try {
      const st = statSync(f);
      parts.push(`${f}|${String(st.mtimeMs)}|${String(st.size)}`);
    } catch {
      parts.push(`${f}|missing`);
    }
  }
  return parts.join('\n');
}

/**
 * Diff two fingerprints (computed by `computeFilesFingerprint`) and
 * return the absolute file paths that differ. A file appears in the
 * result if it was added, removed, or had its mtime/size change. The
 * leading file-count line is ignored. Used by the incremental
 * rebuild path.
 */
export function diffFingerprints(
  cachedFingerprint: string,
  currentFingerprint: string,
): readonly string[] {
  const cachedMap = parseFingerprint(cachedFingerprint);
  const currentMap = parseFingerprint(currentFingerprint);
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

function parseFingerprint(fingerprint: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = fingerprint.split('\n');
  // Skip the leading file-count line.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (typeof line !== 'string' || line.length === 0) continue;
    const firstPipe = line.indexOf('|');
    if (firstPipe === -1) continue;
    const path = line.slice(0, firstPipe);
    const mark = line.slice(firstPipe + 1);
    out.set(path, mark);
  }
  return out;
}
