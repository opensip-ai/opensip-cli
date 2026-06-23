/**
 * Graph evidence seam — the ONLY production module that may import
 * `@opensip-cli/graph/internal` (dependency-cruiser carve-out).
 */

import { CatalogRepo, executeGraph } from '@opensip-cli/graph/internal';

import { withPreservedExitCode } from '../lib/isolate-exit-code.js';

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

  // auto: best-effort enrichment. With a graph adapter in scope, delegate to
  // graph's cache-invalidation path so stale persisted rows are rebuilt or
  // incrementally refreshed. A plain `yagni` invocation, though, only loads
  // yagni's own capabilities — no graph adapter is registered — so calling
  // executeGraph would throw "no language adapter is registered" and graph's
  // own error handler would log it to stderr, leaking a confusing warning.
  // In that case degrade gracefully: reuse a previously-persisted catalog if
  // the datastore has one (we can't rebuild without an adapter), else nothing.
  // (Explicit `--graph build` still surfaces the actionable message.)
  // The `graph` subscope is added to RunScope by the graph tool's module
  // augmentation, which isn't visible in yagni's compilation (it's not part of
  // `@opensip-cli/graph/internal`), so read the adapter count structurally.
  const graphScope = cli.scope as { graph?: { adapters?: { size?: number } } };
  if ((graphScope.graph?.adapters?.size ?? 0) === 0) {
    const catalog = new CatalogRepo(datastore).loadCatalogContract();
    return {
      catalog,
      mode,
      built: false,
      detail:
        catalog === null
          ? 'no graph adapter; no cached catalog'
          : 'reused cached catalog (no adapter to rebuild)',
    };
  }

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
  await withPreservedExitCode(cli, () =>
    executeGraph({ cwd, json: true, noCache: opts.force }, cli),
  );
  const datastore = cli.scope.datastore() as DataStore | undefined;
  if (datastore === undefined) return null;
  return new CatalogRepo(datastore).loadCatalogContract();
}
