/**
 * Tarjan's strongly-connected components algorithm over the call graph.
 *
 * Pure-algorithm module emitted as a JS string. Operates over the
 * browser-built `indexes.callees` map (bodyHash → bodyHash[]).
 *
 * Returns an array of SCCs, each as a sorted array of bodyHashes.
 * Singletons (size === 1) are included by the algorithm; the view
 * filters them out per §3 View 6.
 *
 * O(V + E). Iterative implementation (no recursion) so deep call graphs
 * don't blow the JS engine stack.
 */

export function dashboardSccJs(): string {
  return String.raw`
function findSccs(indexes) {
  const result = [];
  if (!indexes || !indexes.byBodyHash) return result;
  const nodes = Array.from(indexes.byBodyHash.keys());
  const index = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  let nextIndex = 0;

  // Iterative Tarjan via explicit work-frame stack.
  function adj(v) { return indexes.callees.get(v) || []; }

  for (const start of nodes) {
    if (index.has(start)) continue;
    const work = [{ v: start, ai: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const v = frame.v;
      if (frame.ai === 0) {
        index.set(v, nextIndex);
        lowlink.set(v, nextIndex);
        nextIndex++;
        stack.push(v);
        onStack.add(v);
      }
      const adjV = adj(v);
      let descended = false;
      while (frame.ai < adjV.length) {
        const w = adjV[frame.ai++];
        if (!index.has(w)) {
          work.push({ v: w, ai: 0 });
          descended = true;
          break;
        } else if (onStack.has(w)) {
          if (index.get(w) < lowlink.get(v)) lowlink.set(v, index.get(w));
        }
      }
      if (descended) continue;
      // Pop frame; propagate lowlink to parent.
      if (lowlink.get(v) === index.get(v)) {
        const scc = [];
        while (true) {
          const w = stack.pop();
          onStack.delete(w);
          scc.push(w);
          if (w === v) break;
        }
        scc.sort();
        result.push(scc);
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].v;
        if (lowlink.get(v) < lowlink.get(parent)) lowlink.set(parent, lowlink.get(v));
      }
    }
  }
  return result;
}
`;
}
