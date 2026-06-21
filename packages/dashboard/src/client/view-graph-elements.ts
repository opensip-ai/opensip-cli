/**
 * Element builders + shapes for the Code Graph "Visualization" view.
 *
 * Extracted from `view-graph.ts` (file-length budget): the package-level
 * view-model shape, the Cytoscape element descriptor, and the package-level
 * element/color builders. `view-graph-controls.ts` reuses `GraphElement` for the
 * function-level projector it owns.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

/** A Cytoscape element descriptor (a node or an edge for the live graph). */
export interface GraphElement {
  group: 'nodes' | 'edges';
  data: Record<string, unknown>;
}

/** The slim package-level view-model blob embedded by generator.ts. */
export interface GraphViewModel {
  nodes: { id: string; label: string; totalCoupling?: number; sccId?: string | null }[];
  edges: { source: string; target: string; weight?: number; isCycleEdge?: boolean }[];
}

// Map a sccId to a stable hue so cross-package cyclic clusters are grouped.
export function gvSccColor(sccId: string | null | undefined): string | null {
  if (!sccId) return null;
  let h = 0;
  for (let i = 0; i < sccId.length; i++) {
    h = (h * 31 + (sccId.codePointAt(i) ?? 0)) % 360;
  }
  return 'hsl(' + h + ', 70%, 55%)';
}

// Build the package-level Cytoscape elements from the embedded view-model blob.
export function gvBuildElements(vm: GraphViewModel): GraphElement[] {
  const elements: GraphElement[] = [];
  for (const n of vm.nodes) {
    elements.push({
      group: 'nodes',
      data: {
        // totalCoupling/sccId are non-negative counts / a stable id; `??` mirrors
        // the legacy `||` fallback for these (a 0 coupling stays 0).
        id: n.id,
        label: n.label,
        totalCoupling: n.totalCoupling ?? 0,
        sccId: n.sccId ?? null,
        sccColor: gvSccColor(n.sccId),
      },
    });
  }
  vm.edges.forEach((e, j) => {
    elements.push({
      group: 'edges',
      data: {
        id: 'e' + j,
        source: e.source,
        target: e.target,
        // An edge always carries weight ≥ 1; default to 1 when the blob omits it.
        weight: e.weight ?? 1,
        isCycleEdge: !!e.isCycleEdge,
      },
    });
  });
  return elements;
}
