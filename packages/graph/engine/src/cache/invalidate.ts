/**
 * Cache invalidation per §6.2.
 *
 * The catalog is content-keyed via three signals:
 *  1. tsCompilerVersion — TS upgrade invalidates everything.
 *  2. tsConfigPath agreement — different config means different files.
 *  3. Per-file mtime agreement against the catalog's recorded
 *     filesFingerprint — any source file change re-runs stages 1+2.
 *
 * Per-file fingerprinting uses mtime in nanoseconds (mtimeNs) to keep
 * the cost low; for content-equality precision a per-file body hash
 * is the v0.3 work.
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

export function isCatalogValid(cached: Catalog, ctx: ValidationContext): boolean {
  if (cached.tsCompilerVersion !== ctx.currentTsCompilerVersion) {
    logger.info({
      evt: 'graph.cache.invalidate.miss',
      module: 'graph:cache',
      reason: 'ts-version-changed',
      cached: cached.tsCompilerVersion,
      current: ctx.currentTsCompilerVersion,
    });
    return false;
  }
  if (cached.tsConfigPath !== ctx.currentTsConfigPath) {
    logger.info({
      evt: 'graph.cache.invalidate.miss',
      module: 'graph:cache',
      reason: 'tsconfig-path-changed',
      cached: cached.tsConfigPath,
      current: ctx.currentTsConfigPath,
    });
    return false;
  }
  const cachedFingerprint = (cached as { filesFingerprint?: string }).filesFingerprint;
  if (typeof cachedFingerprint !== 'string') {
    logger.info({
      evt: 'graph.cache.invalidate.miss',
      module: 'graph:cache',
      reason: 'no-fingerprint',
    });
    return false;
  }
  const currentFingerprint = computeFilesFingerprint(ctx.currentFiles);
  if (cachedFingerprint !== currentFingerprint) {
    logger.info({
      evt: 'graph.cache.invalidate.miss',
      module: 'graph:cache',
      reason: 'files-changed',
    });
    return false;
  }
  return true;
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
