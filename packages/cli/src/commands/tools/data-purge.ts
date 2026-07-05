/**
 * `tools data-purge <tool-id>` — per-tool project-data removal (ADR-0042).
 *
 * Rows, never tables: one tool's sessions (payload rows cascade via the
 * schema FK), baseline entries + meta, and tool_state rows, all through
 * repository APIs — no SQL in command code (`restrict-raw-db-access`).
 * Project-scoped by nature (the datastore is per-project). Works for ANY
 * tool id including bundled ones (purging fit history is legitimate).
 *
 * Surface note: the spec drafted `tools data purge` (a nested group); the
 * host group machinery is deliberately one level deep (a nested action-less
 * `data` shell would need its own parity-allowlist entry, completion
 * inventory, and mounter recursion for one leaf), so this ships flattened as
 * `data-purge`. Recorded as a plan deviation.
 */

import { buildToolIdentityIndex, type ToolRegistry } from '@opensip-cli/core';
import { BaselineRepo, ToolStateRepo, type DataStore } from '@opensip-cli/datastore';
import { SessionRepo } from '@opensip-cli/session-store';

import type { ToolsDataPurgeResult } from '@opensip-cli/contracts';

/**
 * Every id form one user-supplied tool id may appear under across the stores,
 * derived from the live tool registry when available. The stores key
 * inconsistently for historical reasons: sessions key the layout form (`fit`);
 * the baseline plane keys the identity name (`fitness`); tool-state keys
 * whatever the tool passed. Purging clears every derived form — a per-store key
 * namespace makes clearing an absent form a 0-count no-op.
 */
export function deriveToolDataPurgeIdForms(
  toolId: string,
  registry: ToolRegistry | undefined,
): readonly string[] {
  const binding =
    registry === undefined ? undefined : buildToolIdentityIndex(registry).resolveInput(toolId);
  if (binding === undefined) return [toolId];
  return [...new Set([binding.canonicalName, binding.layoutKey])];
}

/** Purge one tool's rows from the project datastore; reports counts. */
export function toolsDataPurge(
  toolId: string,
  datastore: DataStore,
  idForms: readonly string[] = [toolId],
): ToolsDataPurgeResult {
  const sessionRepo = new SessionRepo(datastore);
  const baselineRepo = new BaselineRepo(datastore);
  const stateRepo = new ToolStateRepo(datastore);

  let sessions = 0;
  let baselineEntries = 0;
  let baselineMeta = false;
  let stateRows = 0;
  for (const form of idForms) {
    sessions += sessionRepo.clearForTool(form);
    const baseline = baselineRepo.clear(form);
    baselineEntries += baseline.entries;
    baselineMeta = baselineMeta || baseline.meta;
    stateRows += stateRepo.clear(form);
  }
  return {
    type: 'tools-data-purge',
    toolId,
    sessions,
    baselineEntries,
    baselineMeta,
    stateRows,
  };
}
