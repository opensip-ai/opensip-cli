/**
 * Cache invalidation per §6.2.
 *
 * The catalog is content-keyed via three signals:
 *  1. tsCompilerVersion — TS upgrade invalidates everything.
 *  2. tsConfigPath agreement — different config means different files.
 *  3. (Future) per-file bodyHash agreement — for incremental rebuilds.
 *
 * v0.2 ships 1 + 2; per-file invalidation is deferred.
 */

import { logger } from '@opensip-tools/core';
import ts from 'typescript';

import type { Catalog } from '../types.js';

export interface ValidationContext {
  readonly currentTsCompilerVersion: string;
  readonly currentTsConfigPath: string;
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
  return true;
}

export function currentTsCompilerVersion(): string {
  return ts.version;
}
