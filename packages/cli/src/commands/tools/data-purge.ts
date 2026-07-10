/**
 * `tools data-purge <tool-id>` — per-tool project-data removal (ADR-0042 / ADR-0146).
 *
 * Rows, never tables: one tool's sessions (payload rows cascade via the
 * schema FK), baseline entries + meta, and tool_state rows (ordinary + reserved
 * host-plane identities), all through repository APIs — no SQL in command code
 * (`restrict-raw-db-access`). Project-scoped by nature (the datastore is
 * per-project). Works for ANY tool id including bundled ones (purging fit
 * history is legitimate).
 *
 * Surface note: the spec drafted `tools data purge` (a nested group); the
 * host group machinery is deliberately one level deep (a nested action-less
 * `data` shell would need its own parity-allowlist entry, completion
 * inventory, and mounter recursion for one leaf), so this ships flattened as
 * `data-purge`. Recorded as a plan deviation.
 */

import {
  buildToolIdentityIndex,
  type Logger,
  type Tool,
  type ToolRegistry,
} from '@opensip-cli/core';
import { BaselineRepo, ToolStateRepo, type DataStore } from '@opensip-cli/datastore';
import { SessionRepo } from '@opensip-cli/session-store';

import {
  hostPlaneStateIdentity,
  isReservedHostPlaneIdentity,
} from '../../bootstrap/host-plane-state.js';
import { toolOwnedKeys } from '../../bootstrap/tool-owned-keys.js';

import type { ToolsDataPurgeResult } from '@opensip-cli/contracts';

/**
 * Reject empty/whitespace or reserved-prefix purge input before opening any
 * repository. Bind every SQLite value; never interpret an id as a path, glob,
 * or SQL fragment.
 *
 * @throws {Error} with a stable message when input is invalid
 */
export function assertToolDataPurgeId(toolId: string): string {
  const trimmed = toolId.trim();
  if (trimmed.length === 0) {
    throw new Error('tools data-purge: tool id must be non-empty');
  }
  if (isReservedHostPlaneIdentity(trimmed)) {
    throw new Error(
      'tools data-purge: reserved host-plane identities cannot be purged by id; pass the ordinary tool id',
    );
  }
  return trimmed;
}

/**
 * Every id form one user-supplied tool id may appear under across the stores,
 * derived from the live tool registry when available. For a registered Tool the
 * validated `toolOwnedKeys` set is used so canonical/layout/stable/replay/config
 * identities are cleaned consistently. Unknown non-empty ids remain a one-key
 * ordinary cleanup pair (plus matching reserved host-plane identity).
 */
export function deriveToolDataPurgeIdForms(
  toolId: string,
  registry: ToolRegistry | undefined,
): readonly string[] {
  const safeId = assertToolDataPurgeId(toolId);
  if (registry !== undefined) {
    const binding = buildToolIdentityIndex(registry).resolveInput(safeId);
    if (binding !== undefined) {
      const tool = registry.get(binding.canonicalName) ?? registry.get(safeId);
      if (tool !== undefined) {
        try {
          return [...toolOwnedKeys(tool as Tool)];
        } catch {
          // Fall through to identity-index forms if binder validation rejects
          // (should not happen for admitted tools).
        }
      }
      return [...new Set([binding.canonicalName, binding.layoutKey])];
    }
  }
  return [safeId];
}

/** Expand ordinary forms with their reserved host-plane identities for state purge. */
function stateIdentities(ordinaryForms: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const form of ordinaryForms) {
    out.add(form);
    try {
      out.add(hostPlaneStateIdentity(form));
    } catch {
      // Skip forms that cannot map (empty/already-reserved should not appear).
    }
  }
  return [...out];
}

/** Purge one tool's rows from the project datastore; reports counts. */
export function toolsDataPurge(
  toolId: string,
  datastore: DataStore,
  idForms: readonly string[] = [toolId],
  logger?: Logger,
): ToolsDataPurgeResult {
  const safeId = assertToolDataPurgeId(toolId);
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
  }
  // State rows: clear ordinary + reserved host-plane identities (ADR-0146).
  for (const identity of stateIdentities(idForms)) {
    stateRows += stateRepo.clear(identity);
  }

  const result: ToolsDataPurgeResult = {
    type: 'tools-data-purge',
    toolId: safeId,
    sessions,
    baselineEntries,
    baselineMeta,
    stateRows,
  };

  if (logger !== undefined) {
    logger.info({
      evt: 'cli.tools.data_purge.complete',
      identityCount: idForms.length,
      sessions,
      baselineEntries,
      baselineMeta,
      stateRows,
    });
  }

  return result;
}
