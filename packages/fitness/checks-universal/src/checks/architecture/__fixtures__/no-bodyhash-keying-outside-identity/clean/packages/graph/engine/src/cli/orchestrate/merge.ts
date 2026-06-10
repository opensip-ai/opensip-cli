// CLEAN: the cross-shard merge keys/stitches edges through the shared identity
// module — every edge-map key is formed via ownerEdgeKey(bodyHash, filePath),
// never a bare hash. Should produce 0 findings.
export function stitch(occ: { bodyHash: string; filePath: string }, edgesByOwner: Map<string, unknown>) {
  const extra = edgesByOwner.get(ownerEdgeKey(occ.bodyHash, occ.filePath))
  cachedByOwner.set(ownerEdgeKey(occ.bodyHash, occ.filePath), occ)
  appendEdge(edgesByOwner, ownerEdgeKey(occ.bodyHash, occ.filePath), edge)
  // bare-hash reads that are NOT map keys are fine: sort + set + target.
  const ids = occs.map((o: { bodyHash: string }) => o.bodyHash)
  return extra
}
