/**
 * Public rebuild facade over runGraph.
 */

import { currentScope, err, normalizeFailure, ok, type Result } from '@opensip-cli/core';

import { realpathOrSelf } from '../cli/graph-sharded-engine.js';
import { resolveDefaultEngineShards } from '../cli/orchestrate/engine-shard-policy.js';
import { loadGraphConfig, runGraph, runShardedGraph } from '../cli/orchestrate.js';
import { currentAdapterRegistry } from '../lang-adapter/registry.js';
import { GraphAdapterSelector } from '../lang-adapter/selector.js';
import { CatalogRepo } from '../persistence/catalog-repo.js';
import { currentRules } from '../rules/registry.js';

import { failGraphRead, reportGraphReadFailure } from './read-boundary-failure.js';

import type { Catalog, GraphReadError, RebuildCatalogInput, GraphReadReason } from './types.js';

function rebuildError(code: GraphReadReason, message: string): GraphReadError {
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
    const catalog = result.catalog;
    if (catalog === null || catalog === undefined) {
      return err(rebuildError('rebuild-empty', 'Graph rebuild produced an empty catalog'));
    }
    if (input.datastore !== undefined) {
      try {
        new CatalogRepo(input.datastore).replaceAll(catalog);
      } catch (error) {
        // D7: the expensive rebuild succeeded. Preserve that usable evidence and record the
        // persistence degradation instead of destroying the catalog with a failed Result.
        // Synchronous evidence reporter inside an async boundary; there is no promise to detach.
        void reportGraphReadFailure(error, {
          boundary: 'infrastructure',
          condition: 'catalog-persistence',
          module: 'graph:read:rebuild',
          reason: 'rebuild-failed',
          operation: 'rebuild',
          message: 'Graph rebuild completed but its catalog could not be persisted',
        });
      }
    }
    return ok(catalog);
  } catch (error) {
    const failure = normalizeFailure(error);
    if (failure.definition.kind === 'cancelled') {
      return err(rebuildError('rebuild-cancelled', 'Graph rebuild was cancelled'));
    }
    if (
      failure.definition.exitClass === 'configuration' ||
      failure.definition.exitClass === 'plugin-incompatible'
    ) {
      return failGraphRead(error, {
        boundary: 'infrastructure',
        condition: 'catalog-rebuild',
        module: 'graph:read:rebuild',
        reason: 'rebuild-configuration',
        operation: 'rebuild',
        message: 'Graph rebuild configuration is invalid',
      });
    }
    return failGraphRead(error, {
      boundary: 'infrastructure',
      condition: 'catalog-rebuild',
      module: 'graph:read:rebuild',
      reason: 'rebuild-failed',
      operation: 'rebuild',
      message: 'Graph rebuild failed due to infrastructure error',
    });
  }
}

interface CanonicalRebuildResult {
  readonly catalog: Catalog | null;
}

async function runCanonicalRebuild(input: RebuildCatalogInput): Promise<CanonicalRebuildResult> {
  // F3 parity with the main graph CLI: realpath so multi-shard workers force
  // occurrence paths against the same canonical root as discovery (symlink cwd).
  // Resolve relative cwd against process.cwd() once — realpathOrSelf(cwd, cwd)
  // double-nests relative roots (packages/app → packages/app/packages/app).
  const root = realpathOrSelf(input.cwd, process.cwd());
  const rebuiltInput = { ...input, cwd: root };
  const scope = currentScope();
  if (scope === undefined) return runGraph({ ...rebuiltInput, noCache: true });
  const adapter = new GraphAdapterSelector(currentAdapterRegistry()).pick({
    cwd: root,
  });
  const graphConfig = loadGraphConfig(root);
  const policy = await resolveDefaultEngineShards({
    projectRoot: root,
    languageAdapters: scope.languages.list(),
    graphAdapter: adapter,
    graphConfig,
    forcedLanguage: false,
  });
  if (policy.shards.length <= 1) return runGraph({ ...rebuiltInput, noCache: true });
  return runShardedGraph({
    shards: policy.shards,
    projectRoot: root,
    cliScript: process.argv[1] ?? '',
    adapter,
    resolutionMode: 'exact',
    useCache: false,
    config: graphConfig,
    rules: currentRules(),
    catalogRepo: null,
  });
}
