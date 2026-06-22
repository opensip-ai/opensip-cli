/**
 * Graph evidence seam — the ONLY production module that may import
 * `@opensip-cli/graph/internal` (dependency-cruiser carve-out).
 */

import { CatalogRepo, executeGraph } from '@opensip-cli/graph/internal';

import type { GraphCatalog } from '@opensip-cli/contracts';
import type { ToolCliContext } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';
import type { YagniGraphMode } from '../types/yagni-config.js';

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
    return { catalog: null, mode, built: false, detail: 'datastore unavailable' };
  }

  const repo = new CatalogRepo(datastore);

  if (mode === 'reuse') {
    const catalog = repo.loadCatalogContract();
    return {
      catalog,
      mode,
      built: false,
      detail: catalog === null ? 'no cached catalog' : 'reused cached catalog',
    };
  }

  if (mode === 'build') {
    const built = await buildGraphCatalog(cwd, cli);
    return {
      catalog: built,
      mode,
      built: built !== null,
      detail: built === null ? 'graph build produced no catalog' : 'built fresh catalog',
    };
  }

  // auto: reuse when warm, otherwise build.
  const cached = repo.loadCatalogContract();
  if (cached !== null) {
    return { catalog: cached, mode, built: false, detail: 'auto reused cached catalog' };
  }
  const built = await buildGraphCatalog(cwd, cli);
  return {
    catalog: built,
    mode,
    built: built !== null,
    detail: built === null ? 'auto build produced no catalog' : 'auto built fresh catalog',
  };
}

async function buildGraphCatalog(cwd: string, cli: ToolCliContext): Promise<GraphCatalog | null> {
  const outcome = await executeGraph({ cwd, json: true, noCache: false }, cli);
  const datastore = cli.scope.datastore() as DataStore | undefined;
  if (datastore === undefined) return null;
  return new CatalogRepo(datastore).loadCatalogContract();
}