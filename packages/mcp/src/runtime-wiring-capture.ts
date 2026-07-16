/** Bounded, accessor-safe capture primitives for live runtime-wiring snapshots. */

import { hasControlCharacter } from './control-text.js';

import type { RuntimeWiringEdge, RuntimeWiringNode } from './runtime-wiring-read-port.js';
import type {
  buildToolIdentityIndex,
  RuntimeCommandInventory,
  Tool,
  ToolPluginManifest,
  ToolProvenance,
  ToolRegistry,
} from '@opensip-cli/core';

export const MAX_RUNTIME_NODES = 10_000;
export const MAX_RUNTIME_EDGES = 20_000;
export const MAX_RUNTIME_FACTS = 10_000;
const MAX_RUNTIME_TEXT = 256;

/** Captured host state used to build one immutable runtime-wiring snapshot. */
export interface LiveRuntimeWiringDeps {
  readonly projectRoot: string;
  /** Project-relative config path for canonical context (default opensip-cli.config.yml). */
  readonly configPath?: string;
  readonly tools: ToolRegistry;
  readonly manifests: readonly ToolPluginManifest[];
  readonly provenance: readonly ToolProvenance[];
  /**
   * Plain host+Tool command inventory from RunScope. Commands/handlers are
   * projected from this only — never from live CommandSpec inspection.
   */
  readonly runtimeCommands?: RuntimeCommandInventory;
}

/** Original command source paired with its immutable, validated identity facts. */
export interface CapturedRuntimeTool {
  readonly source: Tool;
  readonly canonicalName: string;
  readonly stableId: string;
  readonly version: string;
}

/** Mutable bounded accumulator used only while constructing a snapshot. */
export interface MutableRuntimeSnapshot {
  readonly nodes: RuntimeWiringNode[];
  readonly edges: RuntimeWiringEdge[];
  readonly nodeIds: Set<string>;
  readonly edgeIds: Set<string>;
  readonly reasons: Set<string>;
  factsInspected: number;
  factTruncated: boolean;
  nodeTruncated: boolean;
  edgeTruncated: boolean;
}

/** Provenance record matched to a captured tool and its snapshot node. */
export interface MatchedRuntimeProvenance {
  readonly record: ToolProvenance;
  readonly nodeId: string;
}

export type RuntimeToolIdentityIndex = ReturnType<typeof buildToolIdentityIndex>;

/** Result of descriptor-only inspection of an own runtime property. */
export type OwnRuntimeProperty =
  | { readonly kind: 'data'; readonly value: unknown }
  | { readonly kind: 'missing' | 'accessor' | 'invalid' };

/** Create an empty accumulator with all cap and de-duplication state. */
export function createMutableRuntimeSnapshot(): MutableRuntimeSnapshot {
  return {
    nodes: [],
    edges: [],
    nodeIds: new Set(),
    edgeIds: new Set(),
    reasons: new Set(),
    factsInspected: 0,
    factTruncated: false,
    nodeTruncated: false,
    edgeTruncated: false,
  };
}

/** Bound and control-sanitize projected text without retaining the full input. */
export function boundRuntimeText(value: string, state?: MutableRuntimeSnapshot): string {
  const retained: string[] = [];
  let sanitized = false;
  let inspected = 0;
  for (const char of value) {
    if (inspected >= MAX_RUNTIME_TEXT) {
      sanitized = true;
      break;
    }
    inspected++;
    if (hasControlCharacter(char)) {
      sanitized = true;
      continue;
    }
    retained.push(char);
  }
  if (sanitized) state?.reasons.add('text-cap-or-control-sanitization');
  return retained.join('');
}

/** Reserve one bounded input-fact inspection before reading its fields. */
export function reserveRuntimeFact(state: MutableRuntimeSnapshot): boolean {
  if (state.factsInspected >= MAX_RUNTIME_FACTS) {
    state.factTruncated = true;
    state.reasons.add('fact-cap');
    return false;
  }
  state.factsInspected++;
  return true;
}

/** Read an own data property without invoking accessors or propagating Proxy traps. */
export function readOwnRuntimeProperty(target: object, key: PropertyKey): OwnRuntimeProperty {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor === undefined) return { kind: 'missing' };
    if (!('value' in descriptor)) return { kind: 'accessor' };
    return { kind: 'data', value: descriptor.value };
  } catch {
    return { kind: 'invalid' };
  }
}

/** Append one de-duplicated node while enforcing the immutable snapshot cap. */
export function addRuntimeNode(state: MutableRuntimeSnapshot, node: RuntimeWiringNode): boolean {
  if (state.nodeIds.has(node.id)) {
    state.reasons.add('duplicate-node-id');
    return true;
  }
  if (state.nodes.length >= MAX_RUNTIME_NODES) {
    state.nodeTruncated = true;
    state.reasons.add('node-cap');
    return false;
  }
  state.nodeIds.add(node.id);
  state.nodes.push(Object.freeze(node));
  return true;
}

/** Append one de-duplicated edge while enforcing the immutable snapshot cap. */
export function addRuntimeEdge(state: MutableRuntimeSnapshot, edge: RuntimeWiringEdge): boolean {
  const edgeId = `${edge.from}\0${edge.kind}\0${edge.to}\0${edge.source}`;
  if (state.edgeIds.has(edgeId)) {
    state.reasons.add('duplicate-edge-id');
    return true;
  }
  if (state.edges.length >= MAX_RUNTIME_EDGES) {
    state.edgeTruncated = true;
    state.reasons.add('edge-cap');
    return false;
  }
  state.edgeIds.add(edgeId);
  state.edges.push(Object.freeze(edge));
  return true;
}

/** Resolve aliases and layout keys to the canonical registered tool name. */
export function resolveCanonicalRuntimeTool(
  input: string,
  identityIndex: RuntimeToolIdentityIndex,
): string {
  return identityIndex.resolveInput(input)?.canonicalName ?? input;
}

function matchTool(
  stableId: string | undefined,
  humanId: string,
  byStableId: ReadonlyMap<string, CapturedRuntimeTool>,
  byCanonical: ReadonlyMap<string, CapturedRuntimeTool>,
  identityIndex: RuntimeToolIdentityIndex,
): CapturedRuntimeTool | undefined {
  if (stableId !== undefined) {
    const stable = byStableId.get(stableId);
    if (stable !== undefined) return stable;
  }
  return byCanonical.get(resolveCanonicalRuntimeTool(humanId, identityIndex));
}

/** Capture bounded manifest nodes and record their one-to-one tool matches. */
export function addRuntimeManifestNodes(input: {
  readonly deps: LiveRuntimeWiringDeps;
  readonly state: MutableRuntimeSnapshot;
  readonly matchedManifest: Map<CapturedRuntimeTool, string>;
  readonly byStableId: ReadonlyMap<string, CapturedRuntimeTool>;
  readonly byCanonical: ReadonlyMap<string, CapturedRuntimeTool>;
  readonly identityIndex: RuntimeToolIdentityIndex;
}): void {
  const { deps, state, matchedManifest, byStableId, byCanonical, identityIndex } = input;
  for (const manifest of deps.manifests) {
    if (!reserveRuntimeFact(state)) return;
    const tool = matchTool(
      manifest.stableId,
      manifest.identity.name,
      byStableId,
      byCanonical,
      identityIndex,
    );
    const canonical =
      tool?.canonicalName ?? resolveCanonicalRuntimeTool(manifest.identity.name, identityIndex);
    const id = `manifest:${boundRuntimeText(manifest.stableId ?? canonical, state)}`;
    if (
      !addRuntimeNode(state, {
        id,
        kind: 'manifest',
        label: boundRuntimeText(manifest.id, state),
        tool: boundRuntimeText(canonical, state),
        source: 'manifest',
        version: boundRuntimeText(manifest.version, state),
      })
    ) {
      return;
    }
    if (tool === undefined) state.reasons.add('unmatched-manifest');
    else if (matchedManifest.has(tool)) state.reasons.add('duplicate-tool-manifest');
    else matchedManifest.set(tool, id);
  }
}

/** Capture bounded provenance nodes without projecting paths or manifest hashes. */
export function indexRuntimeProvenance(
  deps: LiveRuntimeWiringDeps,
  state: MutableRuntimeSnapshot,
  byStableId: ReadonlyMap<string, CapturedRuntimeTool>,
  byCanonical: ReadonlyMap<string, CapturedRuntimeTool>,
  identityIndex: RuntimeToolIdentityIndex,
): ReadonlyMap<CapturedRuntimeTool, MatchedRuntimeProvenance> {
  const matched = new Map<CapturedRuntimeTool, MatchedRuntimeProvenance>();
  for (const provenance of deps.provenance) {
    if (!reserveRuntimeFact(state)) return matched;
    const tool = matchTool(
      provenance.stableId,
      provenance.id,
      byStableId,
      byCanonical,
      identityIndex,
    );
    const canonical =
      tool?.canonicalName ?? resolveCanonicalRuntimeTool(provenance.id, identityIndex);
    const posture = runtimeWorkerPosture(provenance);
    const nodeId = `provenance:${boundRuntimeText(
      provenance.stableId ?? canonical,
      state,
    )}:${provenance.source}`;
    if (
      !addRuntimeNode(state, {
        id: nodeId,
        kind: 'provenance',
        label: boundRuntimeText(provenance.id, state),
        tool: boundRuntimeText(canonical, state),
        source: 'provenance',
        provenanceSource: provenance.source,
        version: boundRuntimeText(provenance.version, state),
        packageName:
          provenance.packageName === undefined
            ? undefined
            : boundRuntimeText(provenance.packageName, state),
        workerPosture: posture,
      })
    ) {
      return matched;
    }
    if (tool === undefined) state.reasons.add('unmatched-provenance');
    else if (matched.has(tool)) state.reasons.add('duplicate-tool-provenance');
    else matched.set(tool, { record: provenance, nodeId });
  }
  return matched;
}

/** Derive the execution posture exposed by runtime-wiring evidence. */
export function runtimeWorkerPosture(
  provenance: ToolProvenance | undefined,
): RuntimeWiringNode['workerPosture'] {
  if (provenance === undefined) return undefined;
  return provenance.source === 'bundled' ? 'in-process' : 'isolated-worker-proxy';
}
