/**
 * Tests for the Phase 12 flat-monorepo discovery strategy primitives —
 * `detectMonorepoLayout`, `partitionFlatRepo`, `selectStrategyForLayout`.
 *
 * Pure-function coverage only. The actual subprocess fan-out for
 * `synthetic-partition` mode (analogous to `runPackagesInParallel`) is
 * a follow-up wiring change in `graph.ts`; integration validation lives
 * in Phase 14.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectMonorepoLayout,
  partitionFlatRepo,
  selectStrategyForLayout,
} from '../flat-monorepo-strategy.js';

describe('detectMonorepoLayout', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flat-monorepo-detect-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('classifies a packages/* tree with nested package.json as workspaces', () => {
    mkdirSync(join(dir, 'packages', 'a'), { recursive: true });
    mkdirSync(join(dir, 'packages', 'b'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'a', 'package.json'), '{"name":"a"}', 'utf8');
    writeFileSync(join(dir, 'packages', 'b', 'package.json'), '{"name":"b"}', 'utf8');

    const layout = detectMonorepoLayout({
      repoRoot: dir,
      // Inject empty file list to skip the source walk — workspace
      // detection should resolve before file enumeration.
      files: [],
    });

    expect(layout.kind).toBe('workspaces');
    if (layout.kind === 'workspaces') {
      expect(layout.packageDirs).toHaveLength(2);
      expect(layout.packageDirs[0]).toContain(`packages${sep}a`);
      expect(layout.packageDirs[1]).toContain(`packages${sep}b`);
    }
  });

  it('classifies a root package.json with `workspaces` declaration as workspaces', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['apps/*', 'libs/*'] }),
      'utf8',
    );

    const layout = detectMonorepoLayout({ repoRoot: dir, files: [] });

    expect(layout.kind).toBe('workspaces');
  });

  it('classifies a small flat repo (no workspaces) as flat-small', () => {
    // 100 synthetic .ts files — below the default 2500 threshold.
    const files = Array.from({ length: 100 }, (_, i) =>
      join(dir, 'src', `file-${String(i)}.ts`),
    );

    const layout = detectMonorepoLayout({
      repoRoot: dir,
      files,
      nestedPackageDirs: [],
      rootPackageJson: null,
    });

    expect(layout.kind).toBe('flat-small');
    if (layout.kind === 'flat-small') {
      expect(layout.files).toHaveLength(100);
    }
  });

  it('classifies a large flat repo (no workspaces, > threshold) as flat-large', () => {
    // 3000 synthetic .ts files — above the default 2500 threshold.
    const files = Array.from({ length: 3000 }, (_, i) =>
      join(dir, 'src', `file-${String(i)}.ts`),
    );

    const layout = detectMonorepoLayout({
      repoRoot: dir,
      files,
      nestedPackageDirs: [],
      rootPackageJson: null,
    });

    expect(layout.kind).toBe('flat-large');
    if (layout.kind === 'flat-large') {
      expect(layout.files).toHaveLength(3000);
    }
  });

  it('respects a caller-supplied heap-elevation threshold', () => {
    const files = Array.from({ length: 200 }, (_, i) =>
      join(dir, 'src', `file-${String(i)}.ts`),
    );

    const layout = detectMonorepoLayout({
      repoRoot: dir,
      files,
      nestedPackageDirs: [],
      rootPackageJson: null,
      heapElevationThreshold: 100,
    });

    expect(layout.kind).toBe('flat-large');
  });

  it('walks the filesystem when files are not injected', () => {
    mkdirSync(join(dir, 'src', 'api'), { recursive: true });
    writeFileSync(join(dir, 'src', 'api', 'foo.ts'), 'export const x = 1;', 'utf8');
    writeFileSync(join(dir, 'src', 'api', 'bar.tsx'), 'export const y = 2;', 'utf8');
    // Skipped artefact directories should NOT be picked up.
    mkdirSync(join(dir, 'node_modules', 'junk'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'junk', 'index.ts'), 'x', 'utf8');

    const layout = detectMonorepoLayout({
      repoRoot: dir,
      nestedPackageDirs: [],
      rootPackageJson: null,
    });

    expect(layout.kind).toBe('flat-small');
    if (layout.kind === 'flat-small') {
      expect(layout.files).toHaveLength(2);
      expect(layout.files.every((f) => !f.includes('node_modules'))).toBe(true);
    }
  });
});

describe('partitionFlatRepo — directory-depth', () => {
  const repoRoot = '/repo';

  it('buckets files by depth-N path segments', () => {
    const files = [
      `${repoRoot}/src/api/handlers/foo.ts`,
      `${repoRoot}/src/api/routes/bar.ts`,
      `${repoRoot}/src/lib/util.ts`,
    ];

    const partitions = partitionFlatRepo({
      files,
      repoRoot,
      strategy: 'directory-depth',
      depth: 2,
    });

    expect(partitions).toHaveLength(2);
    const byId = new Map(partitions.map((p) => [p.id, p]));
    expect(byId.get('src.api')?.files).toHaveLength(2);
    expect(byId.get('src.lib')?.files).toHaveLength(1);
  });

  it('handles files shallower than the requested depth', () => {
    // `src/foo.ts` has only one directory segment (`src`) — should
    // bucket under `src`, not `src.<missing>`.
    const files = [
      `${repoRoot}/src/foo.ts`,
      `${repoRoot}/src/bar.ts`,
    ];

    const partitions = partitionFlatRepo({
      files,
      repoRoot,
      strategy: 'directory-depth',
      depth: 2,
    });

    expect(partitions).toHaveLength(1);
    expect(partitions[0]?.id).toBe('src');
    expect(partitions[0]?.files).toHaveLength(2);
  });

  it('buckets repo-root files under _root', () => {
    const files = [
      `${repoRoot}/foo.ts`,
      `${repoRoot}/bar.ts`,
    ];

    const partitions = partitionFlatRepo({
      files,
      repoRoot,
      strategy: 'directory-depth',
      depth: 2,
    });

    expect(partitions).toHaveLength(1);
    expect(partitions[0]?.id).toBe('_root');
  });

  it('returns partitions in stable lexicographic order', () => {
    const files = [
      `${repoRoot}/z/foo.ts`,
      `${repoRoot}/a/bar.ts`,
      `${repoRoot}/m/baz.ts`,
    ];

    const partitions = partitionFlatRepo({
      files,
      repoRoot,
      strategy: 'directory-depth',
      depth: 1,
    });

    expect(partitions.map((p) => p.id)).toEqual(['a', 'm', 'z']);
  });
});

describe('partitionFlatRepo — file-count-chunks', () => {
  const repoRoot = '/repo';

  it('splits a flat list into fixed-size chunks', () => {
    const files = Array.from({ length: 5000 }, (_, i) =>
      `${repoRoot}/src/f-${String(i).padStart(5, '0')}.ts`,
    );

    const partitions = partitionFlatRepo({
      files,
      repoRoot,
      strategy: 'file-count-chunks',
      chunkSize: 2000,
    });

    expect(partitions).toHaveLength(3);
    expect(partitions[0]?.id).toBe('chunk-0');
    expect(partitions[0]?.files).toHaveLength(2000);
    expect(partitions[1]?.id).toBe('chunk-1');
    expect(partitions[1]?.files).toHaveLength(2000);
    expect(partitions[2]?.id).toBe('chunk-2');
    expect(partitions[2]?.files).toHaveLength(1000);
  });

  it('produces a single chunk when input ≤ chunkSize', () => {
    const files = Array.from({ length: 100 }, (_, i) =>
      `${repoRoot}/src/f-${String(i)}.ts`,
    );

    const partitions = partitionFlatRepo({
      files,
      repoRoot,
      strategy: 'file-count-chunks',
      chunkSize: 2000,
    });

    expect(partitions).toHaveLength(1);
    expect(partitions[0]?.id).toBe('chunk-0');
  });
});

describe('partitionFlatRepo — hybrid', () => {
  const repoRoot = '/repo';

  it('falls back to chunking inside an oversized directory partition', () => {
    // 5000 files in a single `src/api/` directory. directory-depth=2
    // would yield ONE partition (`src.api`) with 5000 files, exceeding
    // the 2000-file chunk size. Hybrid sub-partitions that one bucket
    // into 3 chunks.
    const files = Array.from({ length: 5000 }, (_, i) =>
      `${repoRoot}/src/api/f-${String(i).padStart(5, '0')}.ts`,
    );

    const partitions = partitionFlatRepo({
      files,
      repoRoot,
      strategy: 'hybrid',
      depth: 2,
      chunkSize: 2000,
    });

    expect(partitions).toHaveLength(3);
    expect(partitions.map((p) => p.id)).toEqual([
      'src.api.chunk-0',
      'src.api.chunk-1',
      'src.api.chunk-2',
    ]);
    expect(partitions[0]?.files).toHaveLength(2000);
    expect(partitions[2]?.files).toHaveLength(1000);
  });

  it('keeps small directory partitions intact', () => {
    // Mixed: one large directory + two small ones.
    const large = Array.from({ length: 3000 }, (_, i) =>
      `${repoRoot}/src/api/f-${String(i).padStart(5, '0')}.ts`,
    );
    const small1 = [`${repoRoot}/src/lib/a.ts`, `${repoRoot}/src/lib/b.ts`];
    const small2 = [`${repoRoot}/src/util/x.ts`];
    const files = [...large, ...small1, ...small2];

    const partitions = partitionFlatRepo({
      files,
      repoRoot,
      strategy: 'hybrid',
      depth: 2,
      chunkSize: 2000,
    });

    // src.api → 2 chunks (3000 / 2000); src.lib → 1; src.util → 1.
    expect(partitions).toHaveLength(4);
    const ids = partitions.map((p) => p.id);
    expect(ids).toContain('src.api.chunk-0');
    expect(ids).toContain('src.api.chunk-1');
    expect(ids).toContain('src.lib');
    expect(ids).toContain('src.util');
  });
});

describe('partitionFlatRepo — input validation', () => {
  it('throws on zero or negative chunkSize', () => {
    expect(() =>
      partitionFlatRepo({
        files: ['/repo/a.ts'],
        repoRoot: '/repo',
        strategy: 'file-count-chunks',
        chunkSize: 0,
      }),
    ).toThrow(/chunkSize must be > 0/);
  });
});

describe('selectStrategyForLayout', () => {
  it('maps workspaces → packages-fanout', () => {
    const selection = selectStrategyForLayout({
      kind: 'workspaces',
      packageDirs: ['/repo/packages/a'],
    });
    expect(selection.mode).toBe('packages-fanout');
    expect(selection.partitionStrategy).toBeUndefined();
  });

  it('maps flat-small → single-process', () => {
    const selection = selectStrategyForLayout({
      kind: 'flat-small',
      files: ['/repo/src/a.ts'],
    });
    expect(selection.mode).toBe('single-process');
    expect(selection.partitionStrategy).toBeUndefined();
  });

  it('maps flat-large → synthetic-partition with hybrid strategy', () => {
    const selection = selectStrategyForLayout({
      kind: 'flat-large',
      files: Array.from({ length: 3000 }, (_, i) => `/repo/src/f-${String(i)}.ts`),
    });
    expect(selection.mode).toBe('synthetic-partition');
    expect(selection.partitionStrategy).toBe('hybrid');
  });
});
