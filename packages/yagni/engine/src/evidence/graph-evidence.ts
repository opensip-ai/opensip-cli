/**
 * Graph evidence seam — the ONLY production module that may import
 * `@opensip-cli/graph/internal` (dependency-cruiser carve-out).
 */

import { CatalogRepo, executeGraph } from '@opensip-cli/graph/internal';

import type { YagniGraphMode } from '../types/yagni-config.js';
import type { GraphCatalog } from '@opensip-cli/contracts';
import type { ToolCliContext } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

export interface GraphEvidenceResult {
  readonly catalog: GraphCatalog | null;
  readonly mode: YagniGraphMode;
  readonly built: boolean;
  readonly detail?: string;
}

export async function resolveGraphEvidence(
  cwd: string,
  mode: YagniGraphMode,
  cli: ToolCliContext,
): Promise<GraphEvidenceResult> {
  if (mode === 'off') {
    return { catalog: null, mode, built: false, detail: 'graph disabled' };
  }

  const datastore = cli.scope.datastore() as DataStore | undefined;
  if (datastore === undefined) {
    return {
      catalog: null,
      mode,
      built: false,
      detail: 'datastore unavailable',
    };
  }

  if (mode === 'reuse') {
    const repo = new CatalogRepo(datastore);
    const catalog = repo.loadCatalogContract();
    return {
      catalog,
      mode,
      built: false,
      detail: catalog === null ? 'no cached catalog' : 'reused cached catalog',
    };
  }

  if (mode === 'build') {
    const built = await buildGraphCatalog(cwd, cli, { force: true });
    return {
      catalog: built,
      mode,
      built: built !== null,
      detail: built === null ? 'graph build produced no catalog' : 'built fresh catalog',
    };
  }

  // auto: delegate to graph's cache invalidation path so stale persisted rows
  // are rebuilt or incrementally refreshed instead of blindly reused.
  const catalog = await buildGraphCatalog(cwd, cli, { force: false });
  return {
    catalog,
    mode,
    built: false,
    detail: catalog === null ? 'auto build produced no catalog' : 'auto resolved graph catalog',
  };
}

async function buildGraphCatalog(
  cwd: string,
  cli: ToolCliContext,
  opts: { readonly force: boolean },
): Promise<GraphCatalog | null> {
  await executeGraph({ cwd, json: true, noCache: opts.force }, cli);
  const datastore = cli.scope.datastore() as DataStore | undefined;
  if (datastore === undefined) return null;
  return new CatalogRepo(datastore).loadCatalogContract();
}
