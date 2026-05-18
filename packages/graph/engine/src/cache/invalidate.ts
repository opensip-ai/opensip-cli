/**
 * Cache invalidation per §6.2.
 *
 * The catalog is content-keyed via three signals:
 *  1. tsCompilerVersion — TS upgrade invalidates everything.
 *  2. tsConfigPath agreement — different config means different files.
 *  3. Per-file mtime agreement against the catalog's recorded
 *     filesFingerprint — any source file change re-runs stages 1+2.
 *
 * Per-file fingerprinting uses mtime + size to keep the cost low.
 *
 * Wave 4 layered an "incremental" verdict on top: when the compiler
 * version + tsconfig agree but some files have changed mtimes, the
 * orchestrator can re-walk only the changed files (plus their
 * transitive edge-dependents) instead of rebuilding everything. See
 * `classifyCatalog` and the orchestrator's incremental path.
 */

import { statSync } from 'node:fs';

import { logger } from '@opensip-tools/core';
import ts from 'typescript';

import type { Catalog } from '../types.js';

export interface ValidationContext {
  readonly currentTsCompilerVersion: string;
  readonly currentTsConfigPath: string;
  readonly currentFiles: readonly string[];
}

/**
 * Wave 4 verdict — three states:
 *   - 'valid': cached catalog matches current file set on every axis;
 *     orchestrator returns it untouched.
 *   - 'incremental': compiler + tsconfig agree, but some files changed.
 *     `changedFiles` lists the absolute paths whose cached entries
 *     must be re-walked. Orchestrator builds the program over all
 *     current files and only walks/resolves the changed set.
 *   - 'invalid': structural mismatch (compiler version, tsconfig path,
 *     missing fingerprint). Orchestrator does a full rebuild.
 */
export type CatalogVerdict =
  | { readonly kind: 'valid' }
  | { readonly kind: 'incremental'; readonly changedFiles: readonly string[] }
  | { readonly kind: 'invalid'; readonly reason: string };

export function classifyCatalog(cached: Catalog, ctx: ValidationContext): CatalogVerdict {
  if (cached.tsCompilerVersion !== ctx.currentTsCompilerVersion) {
    logger.info({
      evt: 'graph.cache.invalidate.miss',
      module: 'graph:cache',
      reason: 'ts-version-changed',
      cached: cached.tsCompilerVersion,
      current: ctx.currentTsCompilerVersion,
    });
    return { kind: 'invalid', reason: 'ts-version-changed' };
  }
  if (cached.tsConfigPath !== ctx.currentTsConfigPath) {
    logger.info({
      evt: 'graph.cache.invalidate.miss',
      module: 'graph:cache',
      reason: 'tsconfig-path-changed',
      cached: cached.tsConfigPath,
      current: ctx.currentTsConfigPath,
    });
    return { kind: 'invalid', reason: 'tsconfig-path-changed' };
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
 * Backwards-compatible boolean wrapper around classifyCatalog. Kept so
 * existing tests/callers that just need "is the cache exactly valid"
 * don't have to switch to the verdict shape.
 */
export function isCatalogValid(cached: Catalog, ctx: ValidationContext): boolean {
  return classifyCatalog(cached, ctx).kind === 'valid';
}

export function currentTsCompilerVersion(): string {
  return ts.version;
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
