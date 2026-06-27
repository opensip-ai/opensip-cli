/**
 * Pure ADR-0043 policy helpers for unclaimed config namespaces.
 */

import type { NamespaceClaimReport, UnclaimedNamespace } from './namespace-claims.js';

/** Unclaimed namespace split used to keep config validation and pre-dispatch policy in sync. */
export interface UnclaimedNamespacePartition {
  readonly toolBugs: readonly UnclaimedNamespace[];
  readonly benign: readonly UnclaimedNamespace[];
}

/**
 * Partition unclaimed namespaces into loaded-tool authoring bugs and benign
 * forward-compatible unknown blocks. Pure: no I/O, throws, or logging.
 */
export function partitionUnclaimedNamespaces(
  report: NamespaceClaimReport,
  loadedToolNames: ReadonlySet<string>,
): UnclaimedNamespacePartition {
  const toolBugs: UnclaimedNamespace[] = [];
  const benign: UnclaimedNamespace[] = [];
  for (const namespace of report.unclaimed) {
    if (loadedToolNames.has(namespace.namespace)) {
      toolBugs.push(namespace);
    } else {
      benign.push(namespace);
    }
  }
  return { toolBugs, benign };
}
