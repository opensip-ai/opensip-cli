/**
 * VIOLATION fixture (R3) — the coverage-contract false-green.
 *
 * Shaped after the graph read coverage contract
 * (`packages/graph/engine/src/read/bounded-view.ts`), where completeness is
 * DERIVED: `makeFacet(requested, reasons)` sets `complete: values.length === 0`.
 * Here both failure paths hand-stamp `complete: true` / `reasons: []` instead,
 * so a catalog read that threw — and a walk that hit its node cap — are both
 * reported to the caller as "analysed everything, nothing to report".
 *
 * Expected: TWO `error-silent-empty-result` findings (the catch return and the
 * cap-guarded return).
 */
interface CoverageFacet {
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly reasons: readonly string[];
}

interface ReadView {
  readonly nodes: readonly string[];
  readonly coverage: CoverageFacet;
}

declare function loadCatalog(path: string): readonly string[];
declare function walk(nodes: readonly string[], cap: number): { nodes: string[]; capped: boolean };

export function readNodes(catalogPath: string, nodeCap: number): ReadView {
  let inventory: readonly string[];
  try {
    inventory = loadCatalog(catalogPath);
  } catch {
    return { nodes: [], coverage: { complete: true, truncated: false, reasons: [] } };
  }

  const walked = walk(inventory, nodeCap);
  if (walked.capped) {
    return { nodes: walked.nodes, coverage: { complete: true, truncated: false, reasons: [] } };
  }

  return { nodes: walked.nodes, coverage: { complete: true, truncated: false, reasons: [] } };
}
