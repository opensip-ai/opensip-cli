/**
 * @fileoverview Pre-execution preparation for fitness recipe runs
 *
 * Syncs the check catalog and prewarms the file cache before check execution.
 */

import { initParseCache } from '@opensip-cli/core';

import { computePrewarmPatterns } from './service-prewarm.js';

import type { FileCache } from '../framework/file-cache.js';
import type { Check, CheckRegistry } from '../framework/registry.js';
import type { FitnessRecipeServiceCallbacks } from './service-types.js';

/** Options for {@link prepareRecipeExecution}. */
export interface PrepareExecutionOptions {
  checks: Check[];
  cwd: string;
  fileCache: FileCache;
  checkRegistry: CheckRegistry;
  callbacks: FitnessRecipeServiceCallbacks;
  prewarmCache?: boolean;
  prewarmPatterns?: string[];
}

/**
 * Prepare for check execution: catalog sync, file-cache prewarm, parse-cache init.
 */
export async function prepareRecipeExecution(opts: PrepareExecutionOptions): Promise<void> {
  // Sync check catalog for dashboard visibility
  if (opts.callbacks.onCatalogSync) {
    const entries = opts.checkRegistry.list().map((c) => ({
      id: c.config.id,
      slug: c.config.slug,
      tags: c.config.tags,
      description: c.config.description,
    }));
    void opts.callbacks.onCatalogSync(entries);
  }

  // Prewarm file cache with only the extensions needed by resolved checks
  if (opts.prewarmCache !== false) {
    const patterns = opts.prewarmPatterns ?? computePrewarmPatterns(opts.checks);
    await opts.fileCache.prewarm(opts.cwd, patterns);
  }

  // Initialize shared AST parse cache for cross-check deduplication
  void initParseCache();
}