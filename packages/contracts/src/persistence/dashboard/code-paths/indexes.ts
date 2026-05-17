/**
 * Browser-side `Indexes` builder — emitted as a JS string for the
 * inlined dashboard script. Mirrors v0.2's `pipeline/indexes.ts`
 * but ported to vanilla JS that runs in the page.
 *
 * Phase P0 stubs the function returning empty maps. Phase P1 fills in
 * the four linear scans (byBodyHash, bySimpleName, callees, callers).
 */

export function dashboardIndexesJs(): string {
  return String.raw`
function buildIndexes(catalog) {
  // Phase P0 stub — Phase P1 implements the four linear scans.
  return {
    byBodyHash: new Map(),
    bySimpleName: new Map(),
    callees: new Map(),
    callers: new Map(),
  };
}
`;
}
