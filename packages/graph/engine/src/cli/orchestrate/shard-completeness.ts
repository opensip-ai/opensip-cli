import { SystemError } from '@opensip-cli/core';

import { graphErrorCatalog } from '../../errors/graph-error-catalog.js';

import type { ShardFailureEvidence } from './shard-model.js';


// Plan 01: the `GRAPH` head was mapped by nothing, so every one of these resolved to
// UNKNOWN_FAILURE — fatal and operator-only — for conditions MCP consumers branch on.
const BUILD_INCOMPLETE = graphErrorCatalog.require('GRAPH.BUILD.INCOMPLETE');

const DISPLAYED_SHARD_FAILURE_LIMIT = 10;

/** Minimal completion evidence returned by the sharded graph engine. */
export interface ShardCompletionEvidence {
  readonly failedShardIds: readonly string[];
  readonly shardFailures?: readonly ShardFailureEvidence[];
}

/** A sharded result carrying the catalog that is safe only after completion validation. */
export interface ShardedCatalogEvidence<CatalogValue> extends ShardCompletionEvidence {
  readonly catalog: CatalogValue;
}

function primaryFailureDetail(primary: ShardFailureEvidence | undefined): string {
  if (primary === undefined) return '';
  const failureClass = primary.failureClass ?? 'unknown';
  let processResult = `exit ${String(primary.exitCode)}`;
  if (primary.signal !== undefined) processResult += `, signal ${primary.signal}`;
  let detail = ` First failure: ${primary.shardId} (${failureClass}, ${processResult})`;
  if (primary.stderrTail === undefined || primary.stderrTail.length === 0) return `${detail}.`;
  detail += `: ${primary.stderrTail}`;
  return detail;
}

/**
 * Reject a partial sharded catalog before it can be rendered or compared with
 * an exact catalog.
 *
 * @throws {SystemError} When one or more shard workers failed.
 */
export function assertShardedBuildComplete(result: ShardCompletionEvidence): void {
  if (result.failedShardIds.length === 0) return;

  const displayed = result.failedShardIds.slice(0, DISPLAYED_SHARD_FAILURE_LIMIT);
  const omitted = result.failedShardIds.length - displayed.length;
  const omittedSuffix = omitted === 0 ? '' : ` (+${String(omitted)} more)`;
  const primary = result.shardFailures?.[0];
  const stderrTail = primary?.stderrTail;
  const primaryDetail = primaryFailureDetail(primary);
  throw new SystemError(
    `Sharded graph build had ${String(result.failedShardIds.length)} shard failure(s); ` +
      `catalog and derived artifacts are incomplete. Failed shard ids: ` +
      `${displayed.join(', ')}${omittedSuffix}.${primaryDetail}`,
    {
      code: BUILD_INCOMPLETE.code,
      definition: BUILD_INCOMPLETE,
      metadata: { view: 'shard-failures' },
      ...(primary?.failureClass === undefined ? {} : { failureClass: primary.failureClass }),
      ...(stderrTail === undefined ? {} : { stderrTail }),
    },
  );
}

/**
 * Return a sharded catalog only when every worker completed.
 *
 * @throws {SystemError} When one or more shard workers failed.
 */
export function requireCompleteShardedCatalog<CatalogValue>(
  result: ShardedCatalogEvidence<CatalogValue>,
): CatalogValue {
  assertShardedBuildComplete(result);
  return result.catalog;
}
