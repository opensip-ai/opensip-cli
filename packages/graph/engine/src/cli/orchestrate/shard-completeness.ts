import { SystemError } from '@opensip-cli/core';

import { graphErrorCatalog } from '../../errors/graph-error-catalog.js';

import type { ShardFailureEvidence } from './shard-model.js';

const SHARD_FAILURES = graphErrorCatalog.require('GRAPH.SHARD.FAILURES');

const DISPLAYED_SHARD_FAILURE_LIMIT = 10;

/** Minimal completion evidence returned by the sharded graph engine. */
export interface ShardCompletionEvidence {
  readonly failedShardIds: readonly string[];
  readonly shardFailures?: readonly ShardFailureEvidence[];
}

/** Shard evidence plus the number of fragments safe to merge. */
export interface ShardUsabilityEvidence extends ShardCompletionEvidence {
  readonly successfulShardCount: number;
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
  if (primary.errorCode !== undefined) processResult += `, code ${primary.errorCode}`;
  const detail = ` First failure: ${primary.shardId} (${failureClass}, ${processResult})`;
  return `${detail}.`;
}

function throwShardFailures(
  result: ShardCompletionEvidence,
  condition: 'no-usable-shards' | 'proof-incomplete',
): never {
  const displayed = result.failedShardIds.slice(0, DISPLAYED_SHARD_FAILURE_LIMIT);
  const omitted = result.failedShardIds.length - displayed.length;
  const omittedSuffix = omitted === 0 ? '' : ` (+${String(omitted)} more)`;
  const primary = result.shardFailures?.[0];
  const stderrTail = primary?.stderrTail;
  const primaryDetail = primaryFailureDetail(primary);
  throw new SystemError(
    `Sharded graph operation had ${String(result.failedShardIds.length)} shard failure(s). ` +
      `Failed shard ids: ${displayed.join(', ')}${omittedSuffix}.${primaryDetail}`,
    {
      code: SHARD_FAILURES.code,
      definition: SHARD_FAILURES,
      metadata: {
        condition,
        count: result.failedShardIds.length,
        ...(primary?.errorCode === undefined ? {} : { errorCode: primary.errorCode }),
        ...(primary === undefined ? {} : { shard: primary.shardId }),
      },
      ...(primary?.failureClass === undefined ? {} : { failureClass: primary.failureClass }),
      ...(stderrTail === undefined ? {} : { stderrTail }),
    },
  );
}

/**
 * Reject a partial sharded catalog before it can be rendered or compared with
 * an exact catalog.
 *
 * @throws {SystemError} When one or more shard workers failed.
 */
export function assertShardedBuildComplete(result: ShardCompletionEvidence): void {
  if (result.failedShardIds.length === 0) return;
  throwShardFailures(result, 'proof-incomplete');
}

/**
 * Hard-fail only when every shard failed and there is nothing trustworthy to
 * merge. A partially successful ordinary run remains useful and is surfaced by
 * the caller as `GRAPH.CATALOG.PARTIAL_COVERAGE` (ruling D7).
 */
export function assertShardedBuildUsable(result: ShardUsabilityEvidence): void {
  if (result.failedShardIds.length === 0 || result.successfulShardCount > 0) return;
  throwShardFailures(result, 'no-usable-shards');
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
