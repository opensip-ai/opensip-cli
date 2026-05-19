/**
 * Cache read — reads a previously persisted Catalog from disk.
 *
 * Returns null on cache miss (no file, malformed JSON, version
 * mismatch). Logs the cache event so consumers can see the path
 * taken.
 */

import { existsSync, readFileSync } from 'node:fs';

import { logger } from '@opensip-tools/core';

import { CatalogIntegrityError } from '../errors.js';

import type { Catalog } from '../types.js';

/**
 * v3 catalogs ship with `language` + `cacheKey`. v2 (older) catalogs
 * stored `tsConfigPath` + `tsCompilerVersion`; loading them returns
 * null so the orchestrator triggers exactly one cold rebuild. See
 * docs/plans/10-graph-language-pluggability.md §5 (catalog v3 migration).
 */
const SUPPORTED_VERSION = '3.0';

export function readCatalog(catalogPath: string): Catalog | null {
  if (!existsSync(catalogPath)) {
    logger.info({
      evt: 'graph.cache.read.miss',
      module: 'graph:cache',
      reason: 'file-not-found',
      path: catalogPath,
    });
    return null;
  }
  try {
    const raw = readFileSync(catalogPath, 'utf8');
    const parsed = JSON.parse(raw) as Catalog;
    if (parsed.version !== SUPPORTED_VERSION) {
      logger.info({
        evt: 'graph.cache.read.miss',
        module: 'graph:cache',
        reason: 'version-mismatch',
        cachedVersion: parsed.version,
        path: catalogPath,
      });
      return null;
    }
    if (parsed.tool !== 'graph') {
      throw new CatalogIntegrityError(
        `Catalog at ${catalogPath} has wrong tool: ${String((parsed as { tool: unknown }).tool)}`,
      );
    }
    if (typeof parsed.language !== 'string' || parsed.language.length === 0) {
      throw new CatalogIntegrityError(
        `Catalog at ${catalogPath} has missing/invalid language field.`,
      );
    }
    if (typeof parsed.cacheKey !== 'string' || parsed.cacheKey.length === 0) {
      throw new CatalogIntegrityError(
        `Catalog at ${catalogPath} has missing/invalid cacheKey field.`,
      );
    }
    logger.info({
      evt: 'graph.cache.read.hit',
      module: 'graph:cache',
      path: catalogPath,
      functions: Object.keys(parsed.functions).length,
    });
    return parsed;
  } catch (error) {
    if (error instanceof CatalogIntegrityError) throw error;
    logger.warn({
      evt: 'graph.cache.read.error',
      module: 'graph:cache',
      path: catalogPath,
      err: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
