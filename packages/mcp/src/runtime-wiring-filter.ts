import { compareCodePointStrings } from '@opensip-cli/graph/read';

import { MAX_GROUP_KEYS } from './graph-query-page.js';

import type {
  RuntimeWiringEdge,
  RuntimeWiringNode,
  RuntimeWiringQuery,
  RuntimeWiringResult,
} from './runtime-wiring-read-port.js';

const MAX_NODES = 10_000;

function addAdjacent(adjacency: Map<string, string[]>, from: string, to: string): void {
  const values = adjacency.get(from) ?? [];
  values.push(to);
  adjacency.set(from, values);
}

function nestedCommandClosure(
  nodes: readonly RuntimeWiringNode[],
  edges: readonly RuntimeWiringEdge[],
): Set<string> {
  const commands = new Set(nodes.map((node) => node.id));
  const queue = [...commands];
  const nested = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'command-nests-under') continue;
    addAdjacent(nested, edge.from, edge.to);
    addAdjacent(nested, edge.to, edge.from);
  }

  for (let index = 0; index < queue.length && commands.size <= MAX_NODES; index++) {
    const current = queue[index];
    if (current === undefined) break;
    for (const related of nested.get(current) ?? []) {
      if (!commands.has(related)) {
        commands.add(related);
        queue.push(related);
      }
    }
  }
  return commands;
}

function addCommandAttachments(
  commands: ReadonlySet<string>,
  edges: readonly RuntimeWiringEdge[],
  selected: Set<string>,
): Set<string> {
  const tools = new Set<string>();
  const mounts = new Set<string>();
  for (const edge of edges) {
    if (edge.kind === 'registry-owns-command' && commands.has(edge.to)) {
      tools.add(edge.from);
      selected.add(edge.from);
    } else if (edge.kind === 'host-mounts-command' && commands.has(edge.from)) {
      mounts.add(edge.to);
      selected.add(edge.to);
    }
  }
  for (const edge of edges) {
    if (edge.kind === 'command-dispatches-handler' && mounts.has(edge.from)) {
      selected.add(edge.to);
    }
  }
  return tools;
}

function addAdmissions(
  tools: ReadonlySet<string>,
  edges: readonly RuntimeWiringEdge[],
  selected: Set<string>,
): Set<string> {
  const provenance = new Set<string>();
  for (const edge of edges) {
    if (edge.kind !== 'manifest-admits-tool' || !tools.has(edge.to)) continue;
    selected.add(edge.from);
    if (edge.source === 'provenance') provenance.add(edge.from);
  }
  return provenance;
}

function addWorkerPosture(
  provenance: ReadonlySet<string>,
  edges: readonly RuntimeWiringEdge[],
  selected: Set<string>,
): void {
  for (const edge of edges) {
    if (edge.kind === 'external-worker-dispatch' && provenance.has(edge.from)) {
      selected.add(edge.to);
    }
  }
}

function relatedNodeIds(
  nodes: readonly RuntimeWiringNode[],
  edges: readonly RuntimeWiringEdge[],
): Set<string> {
  const commands = nestedCommandClosure(nodes, edges);
  const selected = new Set(commands);
  const tools = addCommandAttachments(commands, edges, selected);
  const provenance = addAdmissions(tools, edges, selected);
  addWorkerPosture(provenance, edges, selected);
  return selected;
}

/** Applies runtime-wiring filters while retaining the graph around command matches. */
export function filterRuntimeSnapshot(
  snapshot: {
    readonly nodes: readonly RuntimeWiringNode[];
    readonly edges: readonly RuntimeWiringEdge[];
  },
  input: RuntimeWiringQuery,
  canonicalTool: string | undefined,
): {
  readonly nodes: readonly RuntimeWiringNode[];
  readonly edges: readonly RuntimeWiringEdge[];
} {
  const command = input.command?.toLowerCase();
  const provenanceTools =
    input.provenanceSource === undefined
      ? undefined
      : new Set(
          snapshot.nodes
            .filter(
              (node) => node.kind === 'tool' && node.provenanceSource === input.provenanceSource,
            )
            .flatMap((node) => (node.tool === undefined ? [] : [node.tool])),
        );
  const seeds = snapshot.nodes.filter((node) => {
    if (canonicalTool !== undefined && node.tool !== canonicalTool) return false;
    if (
      provenanceTools !== undefined &&
      (node.tool === undefined || !provenanceTools.has(node.tool))
    ) {
      return false;
    }
    if (
      command !== undefined &&
      !(node.kind === 'command' && node.label.toLowerCase().includes(command))
    ) {
      return false;
    }
    return true;
  });
  if (input.command === undefined) {
    const ids = new Set(seeds.map((node) => node.id));
    return {
      nodes: seeds,
      edges: snapshot.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    };
  }
  const ids = relatedNodeIds(seeds, snapshot.edges);
  return {
    nodes: snapshot.nodes.filter((node) => ids.has(node.id)),
    edges: snapshot.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
  };
}

/** Counts bounded runtime-wiring groups for the requested presentation dimension. */
export function groupRuntimeNodes(
  nodes: readonly RuntimeWiringNode[],
  groupBy: RuntimeWiringResult['effectiveFilters']['groupBy'],
): {
  readonly groups?: readonly { readonly key: string; readonly count: number }[];
  readonly groupTruncated: boolean;
} {
  if (groupBy === 'none') return { groupTruncated: false };
  const counts = new Map<string, number>();
  let groupTruncated = false;
  for (const node of nodes) {
    const key =
      groupBy === 'tool'
        ? (node.tool ?? 'unattributed')
        : (node.provenanceSource ?? node.source ?? 'unattributed');
    const count = counts.get(key);
    if (count !== undefined) {
      counts.set(key, count + 1);
    } else if (counts.size < MAX_GROUP_KEYS) {
      counts.set(key, 1);
    } else {
      groupTruncated = true;
    }
  }
  return {
    groups: [...counts.entries()]
      .sort(([a], [b]) => compareCodePointStrings(a, b))
      .map(([key, count]) => ({ key, count })),
    groupTruncated,
  };
}
