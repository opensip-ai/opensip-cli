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

const SUPPORTED_VERSION = '2.0';

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
    if (parsed.tool !== 'graph' || parsed.language !== 'typescript') {
      throw new CatalogIntegrityError(
        `Catalog at ${catalogPath} has wrong tool/language: ${parsed.tool}/${parsed.language}`,
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
