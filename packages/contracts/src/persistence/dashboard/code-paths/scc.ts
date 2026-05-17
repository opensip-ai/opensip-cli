/**
 * Tarjan's strongly-connected components algorithm over the call graph.
 *
 * Pure-algorithm module emitted as a JS string. Operates over the
 * browser-built `indexes.callees` map (bodyHash → bodyHash[]).
 *
 * Phase P0 stub: returns []. Phase P7 implements Tarjan.
 */

export function dashboardSccJs(): string {
  return String.raw`
function findSccs(indexes) {
  // Phase P7 implements Tarjan; Phase P0 returns no SCCs.
  return [];
}
`;
}
