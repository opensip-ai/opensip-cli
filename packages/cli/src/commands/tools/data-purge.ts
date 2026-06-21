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

import {
  isBundledToolShortId,
  isToolLongId,
  TOOL_LONG_TO_SHORT,
  TOOL_SHORT_TO_LONG,
} from '@opensip-cli/core';
import { BaselineRepo, ToolStateRepo, type DataStore } from '@opensip-cli/datastore';
import { SessionRepo } from '@opensip-cli/session-store';

import type { ToolsDataPurgeResult } from '@opensip-cli/contracts';

/**
 * Every id form one user-supplied tool id may appear under across the stores.
 * The stores key inconsistently for historical reasons (`core/tools/ids.ts`):
 * sessions key the SHORT form (`fit`); the baseline plane keys the LONG form
 * (`fitness`); tool-state keys whatever the tool passed. Purging clears every
 * form — a per-store key namespace makes clearing an absent form a 0-count
 * no-op, so this is robust rather than wasteful.
 */
function idFormsFor(toolId: string): readonly string[] {
  if (isToolLongId(toolId)) return [...new Set([toolId, TOOL_LONG_TO_SHORT[toolId]])];
  if (isBundledToolShortId(toolId)) return [...new Set([toolId, TOOL_SHORT_TO_LONG[toolId]])];
  return [toolId];
}

/** Purge one tool's rows from the project datastore; reports counts. */
export function toolsDataPurge(toolId: string, datastore: DataStore): ToolsDataPurgeResult {
  const sessionRepo = new SessionRepo(datastore);
  const baselineRepo = new BaselineRepo(datastore);
  const stateRepo = new ToolStateRepo(datastore);

  let sessions = 0;
  let baselineEntries = 0;
  let baselineMeta = false;
  let stateRows = 0;
  for (const form of idFormsFor(toolId)) {
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
