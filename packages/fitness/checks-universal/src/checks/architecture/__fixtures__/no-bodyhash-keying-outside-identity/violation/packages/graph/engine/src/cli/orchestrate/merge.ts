// VIOLATION: the cross-shard merge buckets/stitches edges by a BARE ownerHash /
// bodyHash, outside edge-identity.ts — the F1 ADR-0003 drift. Should be flagged.
export function stitch(edgesByOwner: Map<string, unknown>, bc: { ownerHash: string }) {
  appendEdge(edgesByOwner, bc.ownerHash, edge)
  const extra = edgesByOwner.get(occ.bodyHash)
  fileByHash.set(occ.bodyHash, occ.filePath)
  return extra
}
