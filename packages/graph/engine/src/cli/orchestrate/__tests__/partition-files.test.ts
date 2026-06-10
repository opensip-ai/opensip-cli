/**
 * Unit coverage for the canonical-set partitioner (Phase 1,
 * graph-sharded-exact-parity): every canonical file is assigned to the unit
 * whose rootDir is its longest matching prefix; files under no unit fall into
 * the synthetic `:root` shard. Exercises longest-prefix selection, the
 * segment-boundary guard, the root shard, empty-shard pruning, and the optional
 * config-anchor spreads.
 */

import { describe, expect, it } from 'vitest';

import { partitionFilesIntoShards, ROOT_SHARD_ID } from '../partition-files.js';

import type { ShardBoundary } from '../partition-files.js';

const UNITS: ShardBoundary[] = [
  { id: 'pkg:core', rootDir: 'packages/core', configPathAbs: 'packages/core/tsconfig.json' },
  { id: 'pkg:core-extra', rootDir: 'packages/core/extra', configPathAbs: 'packages/core/extra/tsconfig.json' },
];

describe('partitionFilesIntoShards', () => {
  it('assigns each file to the LONGEST matching unit prefix', () => {
    const shards = partitionFilesIntoShards({
      canonicalFiles: [
        'packages/core/src/a.ts', // → core
        'packages/core/extra/src/b.ts', // → core-extra (longer prefix wins over core)
      ],
      units: UNITS,
      projectRoot: '',
    });
    const byId = new Map(shards.map((s) => [s.id, s.files]));
    expect(byId.get('pkg:core')).toEqual(['packages/core/src/a.ts']);
    expect(byId.get('pkg:core-extra')).toEqual(['packages/core/extra/src/b.ts']);
  });

  it('routes files under no unit into the synthetic :root shard with the root anchor', () => {
    const shards = partitionFilesIntoShards({
      canonicalFiles: ['scripts/root.ts', 'packages/core/src/a.ts'],
      units: UNITS,
      projectRoot: '/proj',
      rootConfigPathAbs: '/proj/tsconfig.json',
    });
    const root = shards.find((s) => s.id === ROOT_SHARD_ID);
    expect(root?.files).toEqual(['scripts/root.ts']);
    expect(root?.rootDir).toBe('/proj');
    expect(root?.configPathAbs).toBe('/proj/tsconfig.json');
  });

  it('does NOT cross a non-segment-boundary prefix match (foo vs foobar)', () => {
    const shards = partitionFilesIntoShards({
      canonicalFiles: ['packages/foobar/src/x.ts'],
      units: [{ id: 'pkg:foo', rootDir: 'packages/foo' }],
      projectRoot: '',
    });
    // `packages/foo` is NOT a prefix of `packages/foobar/...` at a boundary, so
    // the file is unowned → root shard, and `pkg:foo` is pruned (empty).
    expect(shards.find((s) => s.id === 'pkg:foo')).toBeUndefined();
    expect(shards.find((s) => s.id === ROOT_SHARD_ID)?.files).toEqual([
      'packages/foobar/src/x.ts',
    ]);
  });

  it('prunes empty unit shards and omits the root shard when nothing is unowned', () => {
    const shards = partitionFilesIntoShards({
      canonicalFiles: ['packages/core/src/a.ts'],
      units: UNITS,
      projectRoot: '',
    });
    // Only the core shard is non-empty; core-extra and :root are absent.
    expect(shards.map((s) => s.id)).toEqual(['pkg:core']);
  });

  it('partition is total + disjoint: union(files) === canonicalFiles, no dupes', () => {
    const canonicalFiles = [
      'packages/core/src/a.ts',
      'packages/core/extra/src/b.ts',
      'scripts/root.ts',
    ];
    const shards = partitionFilesIntoShards({ canonicalFiles, units: UNITS, projectRoot: '' });
    const flat = shards.flatMap((s) => s.files).sort();
    expect(flat).toEqual([...canonicalFiles].sort());
    expect(new Set(flat).size).toBe(flat.length);
  });

  it('omits configPathAbs when a unit (and root) supply none', () => {
    const shards = partitionFilesIntoShards({
      canonicalFiles: ['packages/u/x.ts', 'scripts/y.ts'],
      units: [{ id: 'pkg:u', rootDir: 'packages/u' }],
      projectRoot: '',
    });
    expect(shards.find((s) => s.id === 'pkg:u')).not.toHaveProperty('configPathAbs');
    expect(shards.find((s) => s.id === ROOT_SHARD_ID)).not.toHaveProperty('configPathAbs');
  });

  it('normalizes Windows separators in unit rootDirs and files', () => {
    const shards = partitionFilesIntoShards({
      canonicalFiles: [String.raw`packages\core\src\a.ts`],
      units: [{ id: 'pkg:core', rootDir: String.raw`packages\core` }],
      projectRoot: '',
    });
    expect(shards.find((s) => s.id === 'pkg:core')?.files).toEqual([String.raw`packages\core\src\a.ts`]);
  });

  it('matches a file that equals a unit rootDir exactly', () => {
    const shards = partitionFilesIntoShards({
      canonicalFiles: ['packages/core'],
      units: [{ id: 'pkg:core', rootDir: 'packages/core' }],
      projectRoot: '',
    });
    expect(shards.find((s) => s.id === 'pkg:core')?.files).toEqual(['packages/core']);
  });
});
