import { describe, it, expect } from 'vitest';

import { isMarkerKind, discoverPackagesByMarker } from '../marker-discovery.js';

// Phase 7 fills in real cases. This scaffold confirms the module loads
// and the public surface is callable.
describe('marker-discovery (scaffold)', () => {
  it('isMarkerKind narrows known kinds', () => {
    expect(isMarkerKind('tool')).toBe(true);
    expect(isMarkerKind('fit-pack')).toBe(true);
    expect(isMarkerKind('sim-pack')).toBe(true);
    expect(isMarkerKind('graph-pack')).toBe(false);
    expect(isMarkerKind(undefined)).toBe(false);
  });

  it('returns empty when no node_modules is present', () => {
    expect(discoverPackagesByMarker({ projectDir: '/nonexistent/path/xyz', kind: 'tool' })).toEqual([]);
  });
});
