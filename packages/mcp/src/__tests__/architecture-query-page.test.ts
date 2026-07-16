import { describe, expect, it } from 'vitest';

import {
  decodeArchitectureCursorState,
  nextArchitectureAfterKey,
  type ArchitectureCursorState,
} from '../architecture-query-page.js';

import type { ArchitectureView } from '@opensip-cli/graph/read';

function view(over: Partial<ArchitectureView> = {}): ArchitectureView {
  return {
    packageEdges: [],
    packageEdgesHasMore: false,
    hotspots: [],
    hotspotsHasMore: false,
    ...over,
  } as ArchitectureView;
}

describe('architecture-query-page', () => {
  it('decodes empty and well-formed architecture cursors', () => {
    expect(decodeArchitectureCursorState(undefined)).toEqual({
      ok: true,
      value: { packageEdgesDone: false, hotspotsDone: false },
    });
    const encoded = JSON.stringify({ pd: true, hd: false, p: 'edge-key', h: 'hot-key' });
    const decoded = decodeArchitectureCursorState(encoded);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).toEqual({
      packageEdgesDone: true,
      hotspotsDone: false,
      packageEdgeKey: 'edge-key',
      hotspotKey: 'hot-key',
    });
  });

  it('rejects malformed architecture cursor states', () => {
    expect(decodeArchitectureCursorState('not-json').ok).toBe(false);
    expect(decodeArchitectureCursorState('null').ok).toBe(false);
    expect(decodeArchitectureCursorState('[]').ok).toBe(false);
    expect(decodeArchitectureCursorState(JSON.stringify({ pd: true })).ok).toBe(false);
    expect(decodeArchitectureCursorState(JSON.stringify({ pd: true, hd: false, x: 1 })).ok).toBe(
      false,
    );
    expect(decodeArchitectureCursorState(JSON.stringify({ pd: true, hd: false, p: '' })).ok).toBe(
      false,
    );
    expect(decodeArchitectureCursorState(JSON.stringify({ pd: true, hd: false, h: 3 })).ok).toBe(
      false,
    );
  });

  it('builds next architecture after-key until both families are done', () => {
    const prior: ArchitectureCursorState = {
      packageEdgesDone: false,
      hotspotsDone: false,
    };
    expect(
      nextArchitectureAfterKey(prior, view({ packageEdgesHasMore: false, hotspotsHasMore: false })),
    ).toBeUndefined();

    const withMore = nextArchitectureAfterKey(
      prior,
      view({
        packageEdgesHasMore: true,
        hotspotsHasMore: true,
        packageEdges: [
          {
            fromPackage: 'a',
            toPackage: 'b',
            kind: 'call',
            count: 1,
            countUnit: 'resolved-targets',
            nodeIdentity: 'package',
            sourceScope: 'production',
            generated: 'exclude',
            catalogResolutionMode: 'exact',
          },
        ] as ArchitectureView['packageEdges'],
        hotspots: [
          {
            symbol: {
              symbolId: 'src/a.ts:1:0',
              bodyHash: 'h',
              simpleName: 'fn',
              qualifiedName: 'fn',
              filePath: 'src/a.ts',
              line: 1,
              column: 0,
              kind: 'function-declaration',
              visibility: 'exported',
              package: 'a',
              inTestFile: false,
              definedInGenerated: false,
            },
            direct: 1,
            transitive: 0,
            score: 1,
            identityMode: 'body-twin-union',
            twinCount: 1,
            matchingTwinCount: 1,
            sourceScope: 'production',
            generated: 'exclude',
            edgeKind: 'call',
            catalogResolutionMode: 'exact',
          },
        ] as ArchitectureView['hotspots'],
      }),
    );
    expect(withMore).toBeDefined();
    const parsed = JSON.parse(withMore!) as Record<string, unknown>;
    expect(parsed.pd).toBe(false);
    expect(parsed.hd).toBe(false);
    expect(typeof parsed.p).toBe('string');
    expect(typeof parsed.h).toBe('string');

    // Preserve prior keys when the page has no rows for a family.
    const preserved = nextArchitectureAfterKey(
      { packageEdgesDone: false, hotspotsDone: true, packageEdgeKey: 'kept' },
      view({ packageEdgesHasMore: true, hotspotsHasMore: false, packageEdges: [], hotspots: [] }),
    );
    expect(JSON.parse(preserved!)).toMatchObject({ p: 'kept', pd: false, hd: true });
  });
});
