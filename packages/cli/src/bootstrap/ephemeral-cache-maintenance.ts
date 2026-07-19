import {
  pruneEphemeralRuntimes,
  resolveEphemeralProjectPaths,
  shouldPruneEphemeralRuntimes,
  touchEphemeralRuntime,
  type Logger,
  type ProjectContext,
} from '@opensip-cli/core';

import type {
  RuntimeLeaseLifecycle,
  SafeRuntimeLeaseEventBuffer,
} from '../commands/host-runtime-access.js';

const MODULE_TAG = 'cli:bootstrap';

function heldProjectCoordinationKey(
  lifecycle: RuntimeLeaseLifecycle | undefined,
): string | undefined {
  if (lifecycle?.state() !== 'bootstrap') return;
  const lease = lifecycle.lease;
  if (lease === undefined || !('coordinationKey' in lease) || !('kind' in lease)) return;
  if (
    lease.kind !== 'runtime-read' &&
    !(
      lease.kind === 'runtime-access-composite' &&
      'projectRead' in lease &&
      lease.projectRead === true
    )
  ) {
    return;
  }
  return typeof lease.coordinationKey === 'string' ? lease.coordinationKey : undefined;
}

/**
 * Maintain the bounded no-init cache while the current project's read lease is
 * live. Cache hygiene is deliberately best-effort and cannot fail the command.
 */
export async function maintainEphemeralCache(
  project: ProjectContext,
  logger: Logger,
  lifecycle: RuntimeLeaseLifecycle | undefined,
  leaseEvents: SafeRuntimeLeaseEventBuffer | undefined,
): Promise<void> {
  if (project.scope !== 'ephemeral') return;
  try {
    const paths = resolveEphemeralProjectPaths(project.projectRoot);
    const coordinationKey = heldProjectCoordinationKey(lifecycle);
    if (coordinationKey === undefined || coordinationKey !== paths.coordinationKey) return;
    touchEphemeralRuntime(paths, Date.now(), leaseEvents?.onEvent);
    if (!shouldPruneEphemeralRuntimes(Date.now(), leaseEvents?.onEvent)) return;
    const pruned = await pruneEphemeralRuntimes({
      protectedCoordinationKeys: [coordinationKey],
      onEvent: leaseEvents?.onEvent,
    });
    const removed = pruned.removedOrphaned + pruned.removedStale + pruned.removedOverflow;
    const skipped = pruned.skippedActive + pruned.skippedChanged;
    if (removed === 0 && skipped === 0) return;
    const removedEntryLabel = removed === 1 ? 'entry' : 'entries';
    const skippedEntryLabel = skipped === 1 ? 'entry' : 'entries';
    logger.debug?.({
      evt: 'cli.cache.ephemeral_pruned',
      module: MODULE_TAG,
      scanned: pruned.scanned,
      removedOrphaned: pruned.removedOrphaned,
      removedStale: pruned.removedStale,
      removedOverflow: pruned.removedOverflow,
      skippedActive: pruned.skippedActive,
      skippedChanged: pruned.skippedChanged,
      msg:
        removed > 0
          ? `Pruned ${removed} unused no-init cache ${removedEntryLabel}.`
          : `Preserved ${skipped} no-init cache ${skippedEntryLabel} because activity or identity changed.`,
    });
  } catch {
    // Hygiene only — never fail the run.
  }
}
