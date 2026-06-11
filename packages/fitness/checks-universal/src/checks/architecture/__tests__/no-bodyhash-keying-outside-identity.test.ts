import { describe, it, expect } from 'vitest';

import { analyzeNoBodyhashKeyingOutsideIdentity } from '../no-bodyhash-keying-outside-identity.js';

const MERGE_PATH = 'packages/graph/engine/src/cli/orchestrate/cross-shard-resolve.ts';
const IDENTITY_PATH = 'packages/graph/engine/src/cli/orchestrate/edge-identity.ts';
const ADAPTER_PATH = 'packages/graph/graph-typescript/src/edges.ts';
const TEST_PATH = 'packages/graph/engine/src/cli/orchestrate/__tests__/cross-shard-resolve.test.ts';

describe('no-bodyhash-keying-outside-identity', () => {
  it('flags an appendEdge keyed by a bare ownerHash in the merge layer', () => {
    const content = `
      for (const bc of boundaryCalls) {
        appendEdge(edgesByOwner, bc.ownerHash, edge);
      }
    `;
    const v = analyzeNoBodyhashKeyingOutsideIdentity(content, MERGE_PATH);
    expect(v).toHaveLength(1);
    expect(v[0]?.type).toBe('no-bodyhash-keying-outside-identity');
    expect(v[0]?.message).toContain("'ownerHash'");
  });

  it('flags a Map .get keyed by a bare bodyHash in the merge layer', () => {
    const content = `const extra = edgesByOwner.get(o.bodyHash);`;
    const v = analyzeNoBodyhashKeyingOutsideIdentity(content, MERGE_PATH);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("'bodyHash'");
  });

  it('flags a Map .set keyed by a bare bodyHash (the deleted buildFileByHash shape)', () => {
    const content = `for (const o of occs) map.set(o.bodyHash, o.filePath);`;
    expect(analyzeNoBodyhashKeyingOutsideIdentity(content, MERGE_PATH)).toHaveLength(1);
  });

  it('does NOT flag a key wrapped in ownerEdgeKey (the canonical occurrence key)', () => {
    const content = `
      const extra = edgesByOwner.get(ownerEdgeKey(o.bodyHash, o.filePath));
      cachedByOwner.set(ownerEdgeKey(o.bodyHash, o.filePath), o);
    `;
    expect(analyzeNoBodyhashKeyingOutsideIdentity(content, MERGE_PATH)).toHaveLength(0);
  });

  it('does NOT flag bare-hash reads that are not map keys (sort, set, target)', () => {
    const content = `
      a.bodyHash.localeCompare(b.bodyHash);
      set.add(o.bodyHash);
      return { ...base, to: [linked.bodyHash] };
      const key = \`\${o.bodyHash}@\${e.line}\`;
    `;
    expect(analyzeNoBodyhashKeyingOutsideIdentity(content, MERGE_PATH)).toHaveLength(0);
  });

  it('exempts the identity module itself (the one allowed home)', () => {
    const content = `
      const bucket = byOwner.get(ownerEdgeKey(bodyHash, filePath));
      appendEdge(edgesByOwner, bc.ownerHash, edge);
    `;
    expect(analyzeNoBodyhashKeyingOutsideIdentity(content, IDENTITY_PATH)).toHaveLength(0);
  });

  it('does NOT target the per-adapter resolvers (a different layer)', () => {
    const content = `appendEdge(edgesByOwner, ownerHash, edge);`;
    expect(analyzeNoBodyhashKeyingOutsideIdentity(content, ADAPTER_PATH)).toHaveLength(0);
  });

  it('does NOT target __tests__ fixtures', () => {
    const content = `appendEdge(edgesByOwner, bc.ownerHash, edge);`;
    expect(analyzeNoBodyhashKeyingOutsideIdentity(content, TEST_PATH)).toHaveLength(0);
  });

  it('is inert in adopter repos (path guard)', () => {
    const content = `appendEdge(edgesByOwner, bc.ownerHash, edge);`;
    expect(analyzeNoBodyhashKeyingOutsideIdentity(content, 'src/app/foo.ts')).toHaveLength(0);
  });

  it('does not flag a comment that mentions the bare-hash shape', () => {
    const content = `      // never key edgesByOwner.get(o.bodyHash) directly`;
    expect(analyzeNoBodyhashKeyingOutsideIdentity(content, MERGE_PATH)).toHaveLength(0);
  });
});
