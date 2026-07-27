/**
 * `@opensip-cli/graph` error definitions (Plan 01).
 *
 * `graph` IS a Tool, so this catalog is keyed on its stable tool UUID rather than the package
 * name — the ruling D1 package-name rule governs SUBSTRATE catalogs, and using a package name
 * here would give one owner two identities.
 *
 * Nine `GRAPH.*` literals become four definitions. The `GRAPH` head was mapped by nothing, so
 * every one of them resolved to `CORE.SYSTEM.UNKNOWN_FAILURE` — severity fatal, exposure
 * operator-only. That is a poor fit for most of this surface: a cursor a caller mis-typed and a
 * catalog that changed under a build are neither fatal nor internal, and MCP consumers read
 * these codes to decide whether to retry, re-page, or rebuild.
 */

import { defineErrorCatalog } from '@opensip-cli/core';

// Imported, not restated: the owner id must be the SAME value the tool registers under, and a
// second copy of a UUID is a divergence waiting to happen.
import { GRAPH_STABLE_ID } from '../identity.js';

import type { ErrorDefinition } from '@opensip-cli/core';

/**
 * `publicPresentationKey` on three definitions below is the ruling `result-reason-code-scope`
 * binding: the same condition is reachable BOTH as a thrown, catalogued error and as a
 * `GraphReadReason` on the non-throwing `@opensip-cli/graph/read` boundary. The key names the
 * reason its definition corresponds to, so the two spellings are linked in one declared place
 * instead of by a reader noticing they look similar.
 *
 * The link is declared on the definition, not on the reason, because the definition is the side
 * that has axes to declare. `GraphReadError` stays a plain-data DTO (ADR-0147).
 */

/** A caller's read request is unusable. Nothing is wrong with the catalog. */
const READ_REQUEST = {
  source: 'application',
  defaultResponsibility: 'tool-author',
  kind: 'validation',
  retry: 'never',
  severity: 'error',
  exposure: 'public',
  exitClass: 'runtime',
  stability: 'public',
  lifecycle: 'active',
} as const satisfies Omit<ErrorDefinition, 'owner' | 'code' | 'operatorAction'>;

export const graphErrorCatalog = defineErrorCatalog(
  {
    id: GRAPH_STABLE_ID,
    displayName: 'graph',
    packageName: '@opensip-cli/graph',
  },
  {
    /**
     * A pagination cursor is not one this view issued.
     *
     * Kept SEPARATE from the other read failures even though the axes match, because MCP
     * consumers branch on it: an invalid cursor means "start the page sequence again", which is
     * a different recovery from "your query was wrong". That is the D9 exception — distinct
     * codes where a consumer genuinely branches.
     */
    'GRAPH.READ.CURSOR_INVALID': {
      ...READ_REQUEST,
      code: 'GRAPH.READ.CURSOR_INVALID',
      publicPresentationKey: 'cursor-invalid',
      operatorAction:
        'Restart the page sequence without a cursor; cursors are only valid for the catalog generation that issued them.',
      publicMetadataKeys: ['view'],
    },

    /**
     * A read query is unusable: an unsupported filter, a bound outside its range, or a source
     * role the config does not define.
     *
     * One code across the views (D9) — the caller fixes its request the same way in each, and
     * `metadata.view` plus `metadata.field` say where.
     */
    'GRAPH.READ.QUERY_INVALID': {
      ...READ_REQUEST,
      code: 'GRAPH.READ.QUERY_INVALID',
      publicPresentationKey: 'query-invalid',
      operatorAction:
        'Correct the named query field; the message states the supported values or bound for it.',
      publicMetadataKeys: ['view', 'field', 'condition'],
    },

    /**
     * The stored catalog cannot be read, or could not be verified against the sources it
     * describes.
     *
     * `integrity` and `environment`: the caller did nothing wrong, and the recovery is to
     * rebuild rather than to change the request. `caller-policy` retry because a rebuild is
     * exactly the retry that fixes it.
     */
    'GRAPH.CATALOG.UNREADABLE': {
      code: 'GRAPH.CATALOG.UNREADABLE',
      publicPresentationKey: 'catalog-unreadable',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'integrity',
      retry: 'caller-policy',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction: 'Run `opensip graph` to rebuild the catalog, then retry the read.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition'],
    },

    /**
     * A build could not produce a complete catalog: sources changed underneath it, or shards
     * failed.
     *
     * `warning` severity and a `success` exit class per ruling D7. The build reports reduced
     * coverage through its own freshness facets, and failing the command outright would
     * destroy a partial catalog that is still useful — and that the coverage fields already
     * describe honestly.
     */
    'GRAPH.BUILD.INCOMPLETE': {
      code: 'GRAPH.BUILD.INCOMPLETE',
      source: 'application',
      defaultResponsibility: 'environment',
      kind: 'conflict',
      retry: 'transient',
      severity: 'warning',
      exposure: 'public',
      exitClass: 'success',
      operatorAction:
        'The graph build did not cover every source. Re-run `opensip graph` when the working tree is settled; the coverage fields report what was missed.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition'],
    },
  },
);
