// @fitness-ignore-file file-length-limit -- composition/facade surface retained as a single module for the MCP/CLI audit evidence rollout; split tracked as follow-up.
/** Command/tool graph assembly for immutable live runtime-wiring snapshots. */

import {
  EMPTY_RUNTIME_COMMAND_INVENTORY,
  ephemeralProjectCacheKey,
  type RuntimeCommandGroup,
  type RuntimeCommandInventory,
  type RuntimeCommandLeaf,
} from '@opensip-cli/core';
import { compareCodePointStrings } from '@opensip-cli/graph/read';

import { digestCanonicalIdentity } from './graph-query-page.js';
import {
  addRuntimeEdge,
  addRuntimeManifestNodes,
  addRuntimeNode,
  boundRuntimeText,
  createMutableRuntimeSnapshot,
  indexRuntimeProvenance,
  reserveRuntimeFact,
  runtimeWorkerPosture,
  type CapturedRuntimeTool,
  type LiveRuntimeWiringDeps,
  type MatchedRuntimeProvenance,
  type MutableRuntimeSnapshot,
  type RuntimeToolIdentityIndex,
} from './runtime-wiring-capture.js';
import { captureRuntimeToolIdentities } from './runtime-wiring-identity.js';

import type { RuntimeWiringNode, RuntimeWiringResult } from './runtime-wiring-read-port.js';

const STATIC_NOT_APPLICABLE = 'not-applicable' as const;
/** Edge/node source for host-contract-owned runtime wiring (declared once). */
const HOST_CONTRACT_SOURCE = 'host-contract' as const;

/** Immutable captured graph and cursor identities used by the read port. */
export interface RuntimeWiringSnapshot {
  /** Opaque internal project digest for cursor binding only. */
  readonly projectKey: string;
  /**
   * Stable `w1:` runtime-wiring identity. Hashes only inventory/manifest/
   * provenance content — excludes volatile `capturedAt`.
   */
  readonly snapshotKey: string;
  readonly capturedAt: string;
  readonly projectRoot: string;
  readonly configPath: string;
  readonly nodes: readonly RuntimeWiringNode[];
  readonly edges: RuntimeWiringResult['edges'];
  readonly coverage: RuntimeWiringResult['coverage'];
  readonly identityIndex: RuntimeToolIdentityIndex;
  readonly inventory: RuntimeCommandInventory;
}

function projectRelativeConfigPath(projectRoot: string, configPath: string): string {
  if (/\p{Cc}/u.test(configPath)) return '<invalid-config-path>';
  // Keep as project-relative claim; never invent absolute paths in the response.
  if (configPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(configPath)) {
    return 'opensip-cli.config.yml';
  }
  return configPath.replaceAll('\\', '/');
}

function inventoryIdentityPayload(inventory: RuntimeCommandInventory): unknown {
  return {
    version: inventory.version,
    complete: inventory.complete,
    reasons: inventory.reasons,
    leaves: inventory.leaves.map((leaf) => ({
      path: leaf.path,
      name: leaf.name,
      aliases: leaf.aliases,
      owner: leaf.owner,
      ownerLabel: leaf.ownerLabel,
      visibility: leaf.visibility,
      scope: leaf.scope,
      output: leaf.output,
      provenanceSource: leaf.provenanceSource,
      packageIdentity: leaf.packageIdentity,
      staticHandler: leaf.staticHandler,
    })),
    groups: inventory.groups.map((group) => ({
      path: group.path,
      name: group.name,
      owner: group.owner,
      ownerLabel: group.ownerLabel,
      visibility: group.visibility,
    })),
  };
}

function addInventoryGroup(state: MutableRuntimeSnapshot, group: RuntimeCommandGroup): boolean {
  const id = `command-group:${group.path}`;
  return addRuntimeNode(state, {
    id,
    kind: 'command-group',
    label: boundRuntimeText(group.name, state),
    tool: group.owner === 'tool' ? boundRuntimeText(group.ownerLabel, state) : undefined,
    source: HOST_CONTRACT_SOURCE,
    owner: group.owner,
    commandPath: boundRuntimeText(group.path, state),
    visibility: group.visibility,
  });
}

function addInventoryLeaf(
  state: MutableRuntimeSnapshot,
  leaf: RuntimeCommandLeaf,
  toolNodeId: string | undefined,
): boolean {
  const commandId = `command:${leaf.path}`;
  const handlerId = `handler:${leaf.path}`;
  const mountId = `host-mount:${leaf.path}`;
  const layoutKey = boundRuntimeText(leaf.ownerLabel, state);
  const common = {
    tool: leaf.owner === 'tool' ? layoutKey : undefined,
    layoutKey: leaf.owner === 'tool' ? layoutKey : undefined,
    owner: leaf.owner,
    commandPath: boundRuntimeText(leaf.path, state),
    visibility: leaf.visibility,
  } as const;

  if (
    !addRuntimeNode(state, {
      id: commandId,
      kind: 'command',
      label: boundRuntimeText(leaf.name, state),
      ...common,
      source: leaf.owner === 'tool' ? 'command-spec' : HOST_CONTRACT_SOURCE,
      aliases: leaf.aliases.map((alias) => boundRuntimeText(alias, state)),
    })
  ) {
    return false;
  }

  if (
    !addRuntimeNode(state, {
      id: handlerId,
      kind: 'handler',
      label: boundRuntimeText(leaf.staticHandler?.declaration ?? leaf.name, state),
      ...common,
      source: leaf.owner === 'tool' ? 'command-spec' : HOST_CONTRACT_SOURCE,
      handlerName: leaf.staticHandler?.declaration,
      staticHandlerPackage: leaf.staticHandler?.package,
      staticHandlerPath: leaf.staticHandler?.path,
      staticHandlerDeclaration: leaf.staticHandler?.declaration,
      packageName: leaf.packageIdentity,
      provenanceSource: leaf.provenanceSource as RuntimeWiringNode['provenanceSource'],
    })
  ) {
    return false;
  }

  if (
    !addRuntimeNode(state, {
      id: mountId,
      kind: 'host-mount',
      label: boundRuntimeText(leaf.name, state),
      ...common,
      source: HOST_CONTRACT_SOURCE,
    })
  ) {
    return false;
  }

  if (
    toolNodeId !== undefined &&
    !addRuntimeEdge(state, {
      from: toolNodeId,
      to: commandId,
      kind: 'registry-owns-command',
      source: 'registry',
      confidence: 'high',
      staticBridge: STATIC_NOT_APPLICABLE,
    })
  ) {
    return false;
  }

  if (
    !addRuntimeEdge(state, {
      from: commandId,
      to: mountId,
      kind: 'host-mounts-command',
      source: HOST_CONTRACT_SOURCE,
      confidence: 'medium',
      staticBridge: STATIC_NOT_APPLICABLE,
    })
  ) {
    return false;
  }

  if (
    !addRuntimeEdge(state, {
      from: mountId,
      to: handlerId,
      kind: 'command-dispatches-handler',
      source: leaf.owner === 'tool' ? 'command-spec' : HOST_CONTRACT_SOURCE,
      confidence: 'medium',
      // Provisional 'unresolved' for every dispatch edge; the static-handler
      // bridge overlay resolves it (to 'resolved') once the catalog loads. A
      // command with no staticHandler stays 'unresolved' — consistent with the
      // overlay, which never marks a dispatch edge 'not-applicable'.
      staticBridge: 'unresolved',
    })
  ) {
    return false;
  }

  return addCommandNestingEdge(state, leaf, commandId);
}

/**
 * Nest a leaf command under its parent path when the path has multiple segments.
 * The parent may be a command LEAF (`fit list` → `command:fit`) OR a command
 * GROUP (`sessions list` → `command-group:sessions`, `fit plugin add` →
 * `command-group:fit plugin`). Groups are added before leaves, so whichever
 * parent node exists is present here — matching only `command:` orphaned every
 * host/plugin group container and its leaves' nesting edges. (P2 Phase 4 fix.)
 * Returns false only when the edge add itself fails, preserving the caller's
 * fail-closed contract.
 */
function addCommandNestingEdge(
  state: MutableRuntimeSnapshot,
  leaf: RuntimeCommandLeaf,
  commandId: string,
): boolean {
  const segments = leaf.path.split(' ');
  if (segments.length <= 1) return true;
  const parentPath = segments.slice(0, -1).join(' ');
  const commandParentId = `command:${parentPath}`;
  const groupParentId = `command-group:${parentPath}`;
  let parentId: string | undefined;
  if (state.nodeIds.has(commandParentId)) parentId = commandParentId;
  else if (state.nodeIds.has(groupParentId)) parentId = groupParentId;
  if (parentId === undefined) return true;
  return addRuntimeEdge(state, {
    from: parentId,
    to: commandId,
    kind: 'command-nests-under',
    source: HOST_CONTRACT_SOURCE,
    confidence: 'high',
    staticBridge: STATIC_NOT_APPLICABLE,
  });
}

function addTool(
  state: MutableRuntimeSnapshot,
  tool: CapturedRuntimeTool,
  identityLayoutKey: string,
  manifestId: string | undefined,
  matchedProvenance: MatchedRuntimeProvenance | undefined,
): string | undefined {
  const provenance = matchedProvenance?.record;
  const canonical = tool.canonicalName;
  const layoutKey = boundRuntimeText(identityLayoutKey, state);
  const toolId = `tool:${tool.stableId}`;
  const posture = runtimeWorkerPosture(provenance);
  if (
    !addRuntimeNode(state, {
      id: toolId,
      kind: 'tool',
      label: canonical,
      tool: canonical,
      layoutKey,
      source: 'registry',
      owner: 'tool',
      provenanceSource: provenance?.source,
      version: boundRuntimeText(provenance?.version ?? tool.version, state),
      packageName:
        provenance?.packageName === undefined
          ? undefined
          : boundRuntimeText(provenance.packageName, state),
      workerPosture: posture,
    })
  ) {
    return undefined;
  }
  if (manifestId === undefined) state.reasons.add('unmatched-tool-manifest');
  else {
    addRuntimeEdge(state, {
      from: manifestId,
      to: toolId,
      kind: 'manifest-admits-tool',
      source: 'manifest',
      confidence: 'high',
      staticBridge: STATIC_NOT_APPLICABLE,
    });
  }
  if (matchedProvenance === undefined) {
    state.reasons.add('unmatched-tool-provenance');
  } else {
    addRuntimeEdge(state, {
      from: matchedProvenance.nodeId,
      to: toolId,
      kind: 'manifest-admits-tool',
      source: 'provenance',
      confidence: 'high',
      staticBridge: STATIC_NOT_APPLICABLE,
      reason: 'host-admitted-provenance',
    });
  }
  if (posture === 'isolated-worker-proxy') {
    const workerId = `worker-posture:${canonical}`;
    if (
      addRuntimeNode(state, {
        id: workerId,
        kind: 'worker-posture',
        label: posture,
        tool: canonical,
        layoutKey,
        source: HOST_CONTRACT_SOURCE,
        provenanceSource: provenance?.source,
        workerPosture: posture,
      })
    ) {
      addRuntimeEdge(state, {
        from: matchedProvenance?.nodeId ?? toolId,
        to: workerId,
        kind: 'external-worker-dispatch',
        source: 'provenance',
        confidence: 'high',
        staticBridge: STATIC_NOT_APPLICABLE,
      });
    }
  }
  return toolId;
}

/** Add one tool node per captured tool and index its node id by canonical name. */
function addToolNodesToSnapshot(
  state: MutableRuntimeSnapshot,
  tools: readonly CapturedRuntimeTool[],
  bindingByCanonical: ReadonlyMap<string, RuntimeToolIdentityIndex['bindings'][number]>,
  matchedManifest: ReadonlyMap<CapturedRuntimeTool, string>,
  matchedProvenance: ReadonlyMap<CapturedRuntimeTool, MatchedRuntimeProvenance>,
): Map<string, string> {
  const toolNodeByCanonical = new Map<string, string>();
  for (const tool of tools) {
    if (state.nodeTruncated || state.edgeTruncated) break;
    if (!reserveRuntimeFact(state)) break;
    const binding = bindingByCanonical.get(tool.canonicalName);
    if (binding === undefined) {
      state.reasons.add('unmatched-tool-identity-binding');
      continue;
    }
    const toolId = addTool(
      state,
      tool,
      binding.layoutKey,
      matchedManifest.get(tool),
      matchedProvenance.get(tool),
    );
    if (toolId !== undefined) toolNodeByCanonical.set(tool.canonicalName, toolId);
  }
  return toolNodeByCanonical;
}

/**
 * Project commands (groups then leaves) exclusively from the plain inventory —
 * never live handlers — and record inventory incompleteness reasons.
 */
function addInventoryCommandsToSnapshot(
  state: MutableRuntimeSnapshot,
  inventory: RuntimeCommandInventory,
  toolNodeByCanonical: ReadonlyMap<string, string>,
): void {
  for (const group of inventory.groups) {
    if (!reserveRuntimeFact(state)) break;
    if (!addInventoryGroup(state, group)) break;
  }
  // Sort leaves so parents are more likely present before nested edges attach.
  const orderedLeaves = [...inventory.leaves].sort((a, b) =>
    compareCodePointStrings(a.path, b.path),
  );
  for (const leaf of orderedLeaves) {
    if (!reserveRuntimeFact(state)) break;
    const toolNodeId = leaf.owner === 'tool' ? toolNodeByCanonical.get(leaf.ownerLabel) : undefined;
    if (!addInventoryLeaf(state, leaf, toolNodeId)) break;
  }

  if (!inventory.complete) {
    for (const reason of inventory.reasons) state.reasons.add(reason);
    state.reasons.add('runtime-inventory-incomplete');
  }
}

/** Build and freeze one deterministic runtime-wiring snapshot. */
export function buildRuntimeWiringSnapshot(deps: LiveRuntimeWiringDeps): RuntimeWiringSnapshot {
  const state = createMutableRuntimeSnapshot();
  const inventory = deps.runtimeCommands ?? EMPTY_RUNTIME_COMMAND_INVENTORY;
  const { tools, identityIndex } = captureRuntimeToolIdentities(deps.tools, state);
  const byStableId = new Map(tools.map((tool) => [tool.stableId, tool]));
  const byCanonical = new Map(tools.map((tool) => [tool.canonicalName, tool]));
  const matchedManifest = new Map<CapturedRuntimeTool, string>();
  addRuntimeManifestNodes({
    deps,
    state,
    matchedManifest,
    byStableId,
    byCanonical,
    identityIndex,
  });
  const matchedProvenance = indexRuntimeProvenance(
    deps,
    state,
    byStableId,
    byCanonical,
    identityIndex,
  );
  const bindingByCanonical = new Map(
    identityIndex.bindings.map((binding) => [binding.canonicalName, binding]),
  );
  const toolNodeByCanonical = addToolNodesToSnapshot(
    state,
    tools,
    bindingByCanonical,
    matchedManifest,
    matchedProvenance,
  );

  addInventoryCommandsToSnapshot(state, inventory, toolNodeByCanonical);

  const nodes = Object.freeze([...state.nodes].sort((a, b) => compareCodePointStrings(a.id, b.id)));
  const edges = Object.freeze(
    [...state.edges].sort((a, b) =>
      compareCodePointStrings(`${a.from}\0${a.kind}\0${a.to}`, `${b.from}\0${b.kind}\0${b.to}`),
    ),
  );
  const projectKey = ephemeralProjectCacheKey(deps.projectRoot);
  const configPath = projectRelativeConfigPath(
    deps.projectRoot,
    deps.configPath ?? 'opensip-cli.config.yml',
  );
  // Stable identity: exclude capturedAt; hash inventory + node/edge structure.
  const snapshotKey = `w1:${digestCanonicalIdentity({
    version: 1,
    inventory: inventoryIdentityPayload(inventory),
    nodes: nodes.map((n) => n.id),
    edges: edges.map((e) => `${e.from}|${e.kind}|${e.to}|${e.source}`),
  })}`;
  const truncated = state.nodeTruncated || state.edgeTruncated || state.factTruncated;
  const reasons = [...state.reasons].sort();
  const complete = !truncated && inventory.complete && reasons.length === 0;
  return Object.freeze({
    projectKey,
    snapshotKey,
    capturedAt: new Date().toISOString(),
    projectRoot: deps.projectRoot,
    configPath,
    nodes,
    edges,
    identityIndex,
    inventory,
    coverage: Object.freeze({
      complete,
      scope: 'captured-admitted-registry-and-command-inventory' as const,
      truncated,
      reasons: Object.freeze(reasons),
      runtimeInventoryComplete: inventory.complete,
      staticBridgeComplete: false, // overlaid by bridge when resolved
    }),
  });
}
