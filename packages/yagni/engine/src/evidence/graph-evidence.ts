/**
 * Graph evidence seam — the ONLY production module that may import
 * `@opensip-cli/graph/internal` (dependency-cruiser carve-out).
 */

import { CatalogRepo, runGraph } from '@opensip-cli/graph/internal';

import { withPreservedExitCode } from '../lib/isolate-exit-code.js';

import { ensureGraphAdaptersLoaded } from './load-graph-adapters.js';

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
    await ensureGraphAdaptersLoaded(cwd);
    const built = await buildGraphCatalog(cwd, cli, { force: true });
    return {
      catalog: built,
      mode,
      built: built !== null,
      detail: built === null ? 'graph build produced no catalog' : 'built fresh catalog',
    };
  }

  // auto: best-effort enrichment — load graph adapters (yagni owns the command,
  // so the host did not), then delegate to graph's cache-invalidation path.
  // When adapters still cannot be resolved, degrade to a cached catalog only.
  await ensureGraphAdaptersLoaded(cwd);
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
  const graphScope = cli.scope as { graph?: { adapters?: { size?: number } } };
  if ((graphScope.graph?.adapters?.size ?? 0) === 0) return null;

  const datastore = cli.scope.datastore() as DataStore | undefined;
  if (datastore === undefined) return null;

  // Evidence-only in-process build: `executeGraph` fans out sharded workers that
  // re-bootstrap under yagni (no graph-adapter domain), so fragments never land.
  // `runGraph` reuses the adapters yagni loaded above without emitting a graph
  // CLI envelope onto stdout. Persist explicitly afterward: the orchestrator
  // skips `replaceAll` when `noCache: true` (build mode), but yagni needs the
  // catalog row for duplicate-body-candidate regardless.
  const result = await withPreservedExitCode(cli, () =>
    runGraph({
      cwd,
      noCache: opts.force,
      rules: [],
      datastore,
    }),
  );
  if (result.catalog !== undefined && result.catalog !== null) {
    new CatalogRepo(datastore).replaceAll(result.catalog);
  }
  return new CatalogRepo(datastore).loadCatalogContract();
}
