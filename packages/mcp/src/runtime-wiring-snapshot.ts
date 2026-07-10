/** Command/tool graph assembly for immutable live runtime-wiring snapshots. */

import { ephemeralProjectCacheKey } from '@opensip-cli/core';
import { compareCodePointStrings } from '@opensip-cli/graph/read';

import { digestCanonicalIdentity } from './graph-query-page.js';
import {
  addRuntimeEdge,
  addRuntimeManifestNodes,
  addRuntimeNode,
  boundRuntimeText,
  capturedCommandSpecs,
  createMutableRuntimeSnapshot,
  indexRuntimeProvenance,
  readCapturedCommandSurface,
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

/** Immutable captured graph and cursor identities used by the read port. */
export interface RuntimeWiringSnapshot {
  readonly projectKey: string;
  readonly snapshotKey: string;
  readonly nodes: readonly RuntimeWiringNode[];
  readonly edges: RuntimeWiringResult['edges'];
  readonly coverage: RuntimeWiringResult['coverage'];
  readonly identityIndex: RuntimeToolIdentityIndex;
}

interface CommandContext {
  readonly state: MutableRuntimeSnapshot;
  readonly tool: CapturedRuntimeTool;
  readonly toolId: string;
  readonly layoutKey: string;
  readonly commandIds: Map<string, string>;
  readonly pendingParents: {
    readonly childId: string;
    readonly parent: string;
  }[];
}

function addCommand(context: CommandContext, rawSpec: unknown): boolean {
  const { state, tool, toolId, layoutKey, commandIds, pendingParents } = context;
  const spec = readCapturedCommandSurface(rawSpec, state);
  if (spec === undefined) {
    state.reasons.add('command-spec-invalid-or-accessor');
    return true;
  }
  const canonical = tool.canonicalName;
  const commandId = `command:${canonical}:${spec.name}`;
  const handlerId = `handler:${canonical}:${spec.name}`;
  const mountId = `host-mount:${canonical}:${spec.name}`;
  const common = { tool: canonical, layoutKey } as const;
  if (
    !addRuntimeNode(state, {
      id: commandId,
      kind: 'command',
      label: spec.name,
      ...common,
      source: 'command-spec',
    })
  ) {
    return false;
  }
  if (
    spec.handlerObserved &&
    !addRuntimeNode(state, {
      id: handlerId,
      kind: 'handler',
      label: spec.handlerName ?? 'anonymous-handler',
      ...common,
      source: 'command-spec',
      handlerName: spec.handlerName,
      handlerArity: spec.handlerArity,
    })
  ) {
    return false;
  }
  if (
    !addRuntimeNode(state, {
      id: mountId,
      kind: 'host-mount',
      label: spec.name,
      ...common,
      source: 'host-contract',
    })
  ) {
    return false;
  }
  if (
    !addRuntimeEdge(state, {
      from: toolId,
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
      source: 'host-contract',
      confidence: 'medium',
      staticBridge: STATIC_NOT_APPLICABLE,
    })
  ) {
    return false;
  }
  if (
    spec.handlerObserved &&
    !addRuntimeEdge(state, {
      from: mountId,
      to: handlerId,
      kind: 'command-dispatches-handler',
      source: 'command-spec',
      confidence: 'medium',
      staticBridge: 'unresolved',
    })
  ) {
    return false;
  }
  commandIds.set(spec.name, commandId);
  if (spec.parent !== undefined) pendingParents.push({ childId: commandId, parent: spec.parent });
  return true;
}

function addToolCommands(
  state: MutableRuntimeSnapshot,
  tool: CapturedRuntimeTool,
  toolId: string,
  layoutKey: string,
): void {
  const commandIds = new Map<string, string>();
  const pendingParents: {
    readonly childId: string;
    readonly parent: string;
  }[] = [];
  const context = {
    state,
    tool,
    toolId,
    layoutKey,
    commandIds,
    pendingParents,
  };
  for (const spec of capturedCommandSpecs(tool.source, state)) {
    if (!addCommand(context, spec)) break;
  }
  for (const pending of pendingParents) {
    const parentId = commandIds.get(pending.parent);
    if (parentId === undefined) {
      state.reasons.add('unmatched-command-parent');
      continue;
    }
    if (
      !addRuntimeEdge(state, {
        from: parentId,
        to: pending.childId,
        kind: 'command-nests-under',
        source: 'host-contract',
        confidence: 'high',
        staticBridge: STATIC_NOT_APPLICABLE,
      })
    ) {
      break;
    }
  }
}

function addTool(
  state: MutableRuntimeSnapshot,
  tool: CapturedRuntimeTool,
  identityLayoutKey: string,
  manifestId: string | undefined,
  matchedProvenance: MatchedRuntimeProvenance | undefined,
): void {
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
      provenanceSource: provenance?.source,
      version: boundRuntimeText(provenance?.version ?? tool.version, state),
      packageName:
        provenance?.packageName === undefined
          ? undefined
          : boundRuntimeText(provenance.packageName, state),
      workerPosture: posture,
    })
  ) {
    return;
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
        source: 'host-contract',
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
  addToolCommands(state, tool, toolId, layoutKey);
}

/** Build and freeze one deterministic runtime-wiring snapshot. */
export function buildRuntimeWiringSnapshot(deps: LiveRuntimeWiringDeps): RuntimeWiringSnapshot {
  const state = createMutableRuntimeSnapshot();
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
  for (const tool of tools) {
    if (state.nodeTruncated || state.edgeTruncated) break;
    if (!reserveRuntimeFact(state)) break;
    const binding = bindingByCanonical.get(tool.canonicalName);
    if (binding === undefined) {
      state.reasons.add('unmatched-tool-identity-binding');
      continue;
    }
    addTool(state, tool, binding.layoutKey, matchedManifest.get(tool), matchedProvenance.get(tool));
  }
  state.reasons.add('top-level-host-commands-outside-port');
  const nodes = Object.freeze([...state.nodes].sort((a, b) => compareCodePointStrings(a.id, b.id)));
  const edges = Object.freeze(
    [...state.edges].sort((a, b) =>
      compareCodePointStrings(`${a.from}\0${a.kind}\0${a.to}`, `${b.from}\0${b.kind}\0${b.to}`),
    ),
  );
  const projectKey = ephemeralProjectCacheKey(deps.projectRoot);
  const snapshotKey = `g1:${digestCanonicalIdentity({ version: 1, nodes, edges })}`;
  const truncated = state.nodeTruncated || state.edgeTruncated || state.factTruncated;
  const partialReasons = [...state.reasons].filter(
    (reason) => reason !== 'top-level-host-commands-outside-port',
  );
  return Object.freeze({
    projectKey,
    snapshotKey,
    nodes,
    edges,
    identityIndex,
    coverage: Object.freeze({
      complete: !truncated && partialReasons.length === 0,
      scope: 'captured-admitted-tool-registry' as const,
      truncated,
      reasons: Object.freeze([...state.reasons].sort()),
    }),
  });
}
