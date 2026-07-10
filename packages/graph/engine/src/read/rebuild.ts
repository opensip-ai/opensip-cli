/**
 * Public rebuild facade over runGraph.
 */

import { currentScope, err, ok, type Result } from '@opensip-cli/core';

import { resolveDefaultEngineShards } from '../cli/orchestrate/engine-shard-policy.js';
import { loadGraphConfig, runGraph, runShardedGraph } from '../cli/orchestrate.js';
import { currentAdapterRegistry } from '../lang-adapter/registry.js';
import { GraphAdapterSelector } from '../lang-adapter/selector.js';
import { CatalogRepo } from '../persistence/catalog-repo.js';
import { currentRules } from '../rules/registry.js';

import type { Catalog, GraphReadError, RebuildCatalogInput } from './types.js';

function rebuildError(code: string, message: string): GraphReadError {
  const truncated = message.length > 160 ? message.slice(0, 157) + '...' : message;
  return { code, operation: 'rebuild', message: truncated };
}

/**
 * Rebuild the project catalog via the canonical graph pipeline.
 * Null/empty pipeline output ⇒ GRAPH.READ.REBUILD_EMPTY.
 * Infrastructure throws ⇒ fixed bounded error (no raw message leak).
 */
export async function rebuildCatalog(
  input: RebuildCatalogInput,
): Promise<Result<Catalog, GraphReadError>> {
  try {
    const result = await runCanonicalRebuild(input);
    if (result.failedShardIds !== undefined && result.failedShardIds.length > 0) {
      return err(
        rebuildError(
          'GRAPH.READ.REBUILD_FAILED',
          'Graph rebuild did not complete every configured shard',
        ),
      );
    }
    const catalog = result.catalog;
    if (catalog === null || catalog === undefined) {
      return err(
        rebuildError('GRAPH.READ.REBUILD_EMPTY', 'Graph rebuild produced an empty catalog'),
      );
    }
    if (input.datastore !== undefined) new CatalogRepo(input.datastore).replaceAll(catalog);
    return ok(catalog);
  } catch {
    return err(
      rebuildError('GRAPH.READ.REBUILD_FAILED', 'Graph rebuild failed due to infrastructure error'),
    );
  }
}

interface CanonicalRebuildResult {
  readonly catalog: Catalog | null;
  readonly failedShardIds?: readonly string[];
}

async function runCanonicalRebuild(input: RebuildCatalogInput): Promise<CanonicalRebuildResult> {
  const scope = currentScope();
  if (scope === undefined) return runGraph({ ...input, noCache: true });
  const adapter = new GraphAdapterSelector(currentAdapterRegistry()).pick({
    cwd: input.cwd,
  });
  const graphConfig = loadGraphConfig(input.cwd);
  const policy = await resolveDefaultEngineShards({
    projectRoot: input.cwd,
    languageAdapters: scope.languages.list(),
    graphAdapter: adapter,
    graphConfig,
    forcedLanguage: false,
  });
  if (policy.shards.length <= 1) return runGraph({ ...input, noCache: true });
  return runShardedGraph({
    shards: policy.shards,
    projectRoot: input.cwd,
    cliScript: process.argv[1] ?? '',
    adapter,
    resolutionMode: 'exact',
    useCache: false,
    config: graphConfig,
    rules: currentRules(),
    catalogRepo: null,
  });
}
