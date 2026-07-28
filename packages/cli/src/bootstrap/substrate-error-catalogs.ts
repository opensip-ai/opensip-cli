/**
 * The substrate error catalogs this host loads (Plan 01 ruling D1).
 *
 * WHY THIS LIST EXISTS AT THE COMPOSITION ROOT
 * A substrate package is not a Tool, so it has no `ToolExtensionPoints.errorCatalog` to
 * contribute through — but it does own codes, and a third-party tool that claims one of
 * those codes must be refused rather than silently taking ownership. Only the composition
 * root knows which substrates are linked into this binary, so only it can supply the list.
 * `ToolRegistry` keeps the aggregate and enforces the collision semantics.
 *
 * WHY IT IS A STATIC LIST AND NOT DISCOVERY
 * These are first-party packages compiled into the CLI. Discovering them at runtime would
 * add a filesystem walk to every startup to answer a question that is already settled at
 * build time, and would make the answer depend on install layout. Adding a substrate
 * catalog is a deliberate host change: add the export here, and `pnpm docs:error-index`
 * picks it up from the build-time manifest in `scripts/extract-error-catalog-metadata.mjs`.
 *
 * Core's own catalogs are NOT listed: `aggregateErrorCatalogs` folds `coreSystemErrorCatalog`
 * in unconditionally, and `coreErrorCatalog` shares core's owner identity, so registering it
 * here would make core collide with itself.
 */

import { codebaseErrorCatalog } from '@opensip-cli/codebase';
import { configErrorCatalog } from '@opensip-cli/config';
import { coreErrorCatalog, type SubstrateErrorCatalogContribution } from '@opensip-cli/core';
import { datastoreErrorCatalog } from '@opensip-cli/datastore';
import { externalToolErrorCatalog } from '@opensip-cli/external-tool-adapter';
import { outputErrorCatalog } from '@opensip-cli/output';
import { sessionStoreErrorCatalog } from '@opensip-cli/session-store';
import { treeSitterErrorCatalog } from '@opensip-cli/tree-sitter';

import { hostErrorCatalog } from '../errors/host-error-catalog.js';

/**
 * Substrate catalogs in registration order.
 *
 * `coreErrorCatalog` IS included, with core's own owner id: `aggregateErrorCatalogs` seeds
 * the index from `coreSystemErrorCatalog` only, so without this entry every code authored in
 * Wave 1 would be absent from the runtime aggregate and a third-party tool could claim
 * `CORE.LOCK.MALFORMED` unopposed. The two core catalogs are disjoint by construction — a
 * unit test pins that — so listing one of them cannot collide with the other.
 */
export const HOST_SUBSTRATE_ERROR_CATALOGS: readonly SubstrateErrorCatalogContribution[] = [
  { packageName: 'opensip-cli.core', catalog: coreErrorCatalog },
  { packageName: 'opensip-cli', catalog: hostErrorCatalog },
  { packageName: '@opensip-cli/codebase', catalog: codebaseErrorCatalog },
  { packageName: '@opensip-cli/config', catalog: configErrorCatalog },
  { packageName: '@opensip-cli/datastore', catalog: datastoreErrorCatalog },
  { packageName: '@opensip-cli/session-store', catalog: sessionStoreErrorCatalog },
  { packageName: '@opensip-cli/tree-sitter', catalog: treeSitterErrorCatalog },
  { packageName: '@opensip-cli/output', catalog: outputErrorCatalog },
  { packageName: '@opensip-cli/external-tool-adapter', catalog: externalToolErrorCatalog },
];
