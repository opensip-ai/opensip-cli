/**
 * Cache write — atomic JSON serialization of the catalog.
 *
 * Atomic via tmp + rename so a concurrent run can't observe a torn
 * write. Per §6.3.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { logger, SystemError } from '@opensip-tools/core';

import { normalizeCatalogForSerialization } from './normalize.js';

import type { Catalog } from '../types.js';

export function writeCatalog(catalogPath: string, catalog: Catalog): void {
  try {
    mkdirSync(dirname(catalogPath), { recursive: true });
    const normalized = normalizeCatalogForSerialization(catalog);
    const tmpPath = `${catalogPath}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
    writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, catalogPath);
    logger.info({
      evt: 'graph.cache.write.complete',
      module: 'graph:cache',
      path: catalogPath,
    });
  } catch (error) {
    logger.error({
      evt: 'graph.cache.write.error',
      module: 'graph:cache',
      path: catalogPath,
      err: error instanceof Error ? error.message : String(error),
    });
    throw new SystemError(
      `Failed to write graph catalog: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
