/**
 * Registry-validated tool-id helpers (M3).
 *
 * The pure id constants/types and structural guards live in the leaf
 * `ids.ts`. The two helpers here need the live {@link ToolRegistry} (and
 * therefore `resolveToolHooks`), so they live in this sibling module to
 * keep `ids.ts` a dependency-free leaf — `tool-sessions.ts` imports the
 * `ToolShortId` type from `ids.ts`, and pulling the registry into `ids.ts`
 * would close a module cycle (caught by dependency-cruiser).
 *
 * These are the boundary checks the HOST applies where the per-run tool
 * registry is in scope (the CLI `--tool` filters, `sessions show` replay
 * routing). The tool-vocabulary-free datastore layer can only assert the
 * discriminant's SHAPE (`isToolShortId`); membership-against-the-registry
 * is the host's stronger guarantee.
 */

import { resolveToolHooks } from './resolve-tool-hooks.js';

import type { ToolShortId } from './ids.js';
import type { ToolRegistry } from './registry.js';

/**
 * The set of session short ids the registered tools answer to: each tool's
 * `sessionReplay.tool` (when present) plus its `metadata.name`. Both forms
 * are admitted because a tool may filter/replay under its command verb
 * (`metadata.name`) while persisting under an explicit `sessionReplay.tool`
 * — for the bundled three these coincide.
 */
export function registeredToolShortIds(registry: ToolRegistry): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const tool of registry.list()) {
    const replayTool = resolveToolHooks(tool).sessionReplay?.tool;
    if (replayTool) ids.add(replayTool);
    if (tool.metadata.name) ids.add(tool.metadata.name);
  }
  return ids;
}

/**
 * Registry-validated predicate for the open tool short id (M3). True when
 * `value` is the short id of a tool currently registered in `registry` —
 * i.e. a session row stamped with it has a live tool that can list/replay
 * it. The bundled three are always registered, so this subsumes
 * `isBundledToolShortId` for any normally-configured run.
 */
export function isRegisteredToolId(value: unknown, registry: ToolRegistry): value is ToolShortId {
  if (typeof value !== 'string' || value.length === 0) return false;
  return registeredToolShortIds(registry).has(value);
}
