/**
 * Shared agent-catalog assembly surface (Plan 03, agent-catalog transport
 * parity). Split out of `./agent-catalog.js` so both modules stay under the
 * file-length limit while keeping a single, one-directional value edge
 * (`agent-catalog-assembly` → `agent-catalog`, for `buildAgentCatalog`) — no
 * import cycle forms, so neither `import-x/no-cycle` nor the
 * `circular-import-detection` fitness check fires.
 *
 * This module owns the pure projection path BOTH transports call: the CLI
 * `agent-catalog` command adapter and the `@opensip-cli/mcp` read port assemble
 * the same {@link AgentCatalog} through {@link assembleAgentCatalog}, and MCP
 * projects its reserved-name facts through {@link projectAgentCatalogRuntimeFacts}.
 * All catalog CONTENT still lives in `buildAgentCatalog` — this file adds only
 * the transport-parity projection, never a second reserved-name validator, entry
 * points, or notes.
 */

import { ValidationError } from '@opensip-cli/core';

import { buildAgentCatalog } from './agent-catalog.js';
import { compareCodePoint } from './code-point-order.js';

import type { AgentCatalog } from './agent-catalog.js';
import type { AgentHostSupport } from './host-support.js';
import type { AgentProjectContext } from './target-conventions.js';
import type { RuntimeCommandInventory, ToolRegistry } from '@opensip-cli/core';

/**
 * Input for the shared, pure {@link assembleAgentCatalog} both transports call
 * (Plan 03, agent-catalog transport parity). It is {@link AgentCatalogBuildInput}
 * WITHOUT the caller-controlled `validateOverlays` flag (the assembler always
 * validates) and WITHOUT the nested `reservedNames` object: the two
 * authority-owned lists are carried as flat `rootCommands` / `suiteNames`, since
 * each composition root sources them separately (the CLI from its static
 * `HOST_RESERVED_ROOT_COMMANDS` + config's `RESERVED_SUITE_NAMES`; MCP from the
 * runtime inventory via {@link projectAgentCatalogRuntimeFacts} + config's
 * `RESERVED_SUITE_NAMES`). The lists are authority-owned and pre-ordered — the
 * assembler copies them verbatim and never re-sorts or re-validates them.
 */
export interface AgentCatalogAssemblyInput {
  readonly tools?: ToolRegistry;
  readonly internalCommands?: ReadonlySet<string>;
  readonly projectContext?: AgentProjectContext;
  readonly hostSupport?: AgentHostSupport;
  /** Host-owned root command names a Tool cannot mount (already ordered). */
  readonly rootCommands: readonly string[];
  /** Built-in suite names a configured suite cannot claim (already ordered). */
  readonly suiteNames: readonly string[];
}

/**
 * The single pure path from captured runtime/project facts to the shared
 * {@link AgentCatalog}, used by BOTH the CLI `agent-catalog` adapter and the MCP
 * read port so a common field cannot be wired to only one transport. It copies
 * the authority-owned reserved-name lists WITHOUT reordering (defensive copies —
 * `RESERVED_SUITE_NAMES` intentionally declares `audit` before `agent-context`),
 * omits an empty project context, forces `validateOverlays: true`, and delegates
 * ALL content to {@link buildAgentCatalog}. It adds no second reserved-name
 * validator, entry points, notes, or normalization — projection only.
 */
export function assembleAgentCatalog(input: AgentCatalogAssemblyInput): AgentCatalog {
  const hasProjectContext =
    input.projectContext !== undefined && input.projectContext.targetConventions.length > 0;
  return buildAgentCatalog({
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.internalCommands === undefined ? {} : { internalCommands: input.internalCommands }),
    ...(hasProjectContext ? { projectContext: input.projectContext } : {}),
    ...(input.hostSupport === undefined ? {} : { hostSupport: input.hostSupport }),
    reservedNames: {
      rootCommands: [...input.rootCommands],
      suiteNames: [...input.suiteNames],
    },
    validateOverlays: true,
  });
}

/**
 * Deterministic reserved-root + internal-command facts projected from the
 * complete, immutable {@link RuntimeCommandInventory} the composition root
 * captured on `RunScope.runtimeCommands` (Plan 03, Task 0.2). MCP cannot import
 * the CLI-local `HOST_RESERVED_ROOT_COMMANDS` (layer DAG) and ADR-0159 rejects
 * duplicating that static list in contracts, so it projects the same facts from
 * the same mounted-command data instead.
 */
export interface AgentCatalogRuntimeFacts {
  /** Sorted, unique top-level host-owned root command names + aliases + implicit roots. */
  readonly rootCommands: readonly string[];
  /** Sorted, unique Tool-owned command names whose visibility is `internal`. */
  readonly internalCommands: readonly string[];
}

/**
 * Project {@link AgentCatalogRuntimeFacts} from a complete runtime command
 * inventory plus an explicit list of implicit host roots (MCP passes Commander's
 * implicit `help`; the CLI keeps passing its authoritative static set directly,
 * so this helper treats the implicit list as data, not a new admission authority).
 *
 * `rootCommands` are the top-level HOST-owned leaf/group names plus their aliases
 * plus `implicitRoots`; nested host leaves, Tool commands, Tool plugin groups,
 * and any multi-segment path are excluded. `internalCommands` are the Tool-owned
 * leaf names whose validated `visibility` is `internal` — never inferred from a
 * name regex. Both arrays are code-point sorted, de-duplicated, and frozen.
 *
 * @throws {ValidationError} (`AGENT_CATALOG.INCOMPLETE_INVENTORY`) when
 *   `inventory.complete !== true`: advertising a partial reservation set is less
 *   safe than refusing the discovery read, so it fails closed.
 */
export function projectAgentCatalogRuntimeFacts(
  inventory: RuntimeCommandInventory,
  implicitRoots: readonly string[],
): AgentCatalogRuntimeFacts {
  if (inventory.complete !== true) {
    throw new ValidationError(
      'agent-catalog: cannot project reserved root commands from an incomplete runtime command ' +
        'inventory (complete !== true); the discovery read fails closed rather than advertise a ' +
        'partial reservation set.',
      { code: 'AGENT_CATALOG.INCOMPLETE_INVENTORY' },
    );
  }
  const roots = new Set<string>();
  for (const leaf of inventory.leaves) {
    // Top-level host-owned only: a multi-segment path (contains a space) is a
    // nested host leaf or a Tool path and never a reserved root.
    if (leaf.owner !== 'host' || leaf.path.includes(' ')) continue;
    roots.add(leaf.name);
    for (const alias of leaf.aliases) roots.add(alias);
  }
  for (const group of inventory.groups) {
    if (group.owner !== 'host' || group.path.includes(' ')) continue;
    roots.add(group.name);
  }
  for (const root of implicitRoots) roots.add(root);

  const internal = new Set<string>();
  for (const leaf of inventory.leaves) {
    if (leaf.owner === 'tool' && leaf.visibility === 'internal') internal.add(leaf.name);
  }

  return Object.freeze({
    rootCommands: Object.freeze([...roots].sort(compareCodePoint)),
    internalCommands: Object.freeze([...internal].sort(compareCodePoint)),
  });
}
