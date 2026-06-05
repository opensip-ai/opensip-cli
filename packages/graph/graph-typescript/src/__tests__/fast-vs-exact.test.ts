/**
 * Integration: drive the TypeScript adapter end-to-end in both tiers on
 * one multi-file fixture and assert the honest-approximation contract.
 *
 * (Lives in the adapter package, not the engine, because the engine layer
 * must not import a concrete adapter — so an adapter-driven integration
 * test belongs here.)
 *
 *   - both tiers produce a catalog;
 *   - every fast edge is 'syntactic' and never 'high';
 *   - fast stats never populate resolvedHigh;
 *   - the cacheKey differs between tiers (cache separation);
 *   - fast recovers the cross-file + same-file edges exact found.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { typescriptGraphAdapter as adapter } from '../index.js';

import type { CallEdge, Catalog, ResolutionMode } from '@opensip-tools/graph';

const TSCONFIG = '{ "compilerOptions": { "target": "ES2022", "module": "Node16", "moduleResolution": "Node16" } }';
const UTIL = 'export function helper(x: number): number { return x + 1; }\n';
const APP = [
  "import { helper } from './util.js';",
  'export function main(): number { return helper(41); }',
  'function localOnly(): number { return main(); }',
  'export function run(): number { return localOnly(); }',
].join('\n');

async function buildBothTiers(dir: string): Promise<Record<ResolutionMode, { resolved: Awaited<ReturnType<typeof adapter.resolveCallSites>>; cacheKey: string }>> {
  const run = async (resolutionMode: ResolutionMode): Promise<{ resolved: Awaited<ReturnType<typeof adapter.resolveCallSites>>; cacheKey: string }> => {
    const disc = adapter.discoverFiles({ cwd: dir });
    const parsed = adapter.parseProject({
      projectDirAbs: disc.projectDirAbs,
      files: disc.files,
      compilerOptions: disc.compilerOptions,
      resolutionMode,
    });
    const walk = adapter.walkProject({
      project: parsed.project,
      files: disc.files,
      projectDirAbs: disc.projectDirAbs,
    });
    const cacheKey = adapter.cacheKey({
      projectDirAbs: disc.projectDirAbs,
      configPathAbs: disc.configPathAbs,
      compilerOptions: disc.compilerOptions,
      resolutionMode,
    });
    const catalog: Catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'x',
      cacheKey,
      resolutionMode,
      functions: walk.occurrences,
    };
    const resolved = await adapter.resolveCallSites({
      project: parsed.project,
      catalog,
      callSites: walk.callSites,
      dependencySites: walk.dependencySites,
      projectDirAbs: disc.projectDirAbs,
      resolutionMode,
    });
    return { resolved, cacheKey };
  };
  return { exact: await run('exact'), fast: await run('fast') };
}

function allEdges(byOwner: ReadonlyMap<string, readonly CallEdge[]>): CallEdge[] {
  return [...byOwner.values()].flat();
}

describe('fast vs exact (TypeScript adapter, end-to-end)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-ts-fastvsexact-'));
    writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG, 'utf8');
    writeFileSync(join(dir, 'util.ts'), UTIL, 'utf8');
    writeFileSync(join(dir, 'app.ts'), APP, 'utf8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('both tiers produce edges; fast edges are all syntactic and never high', async () => {
    const { exact, fast } = await buildBothTiers(dir);

    const exactEdges = allEdges(exact.resolved.edgesByOwner);
    const fastEdges = allEdges(fast.resolved.edgesByOwner);
    expect(exactEdges.length).toBeGreaterThan(0);
    expect(fastEdges.length).toBeGreaterThan(0);

    for (const e of fastEdges) {
      expect(e.resolution).toBe('syntactic');
      expect(e.confidence).not.toBe('high');
    }
  });

  it('fast resolution stats never populate resolvedHigh', async () => {
    const { fast } = await buildBothTiers(dir);
    expect(fast.resolved.stats.resolvedHigh).toBe(0);
    // Every located call site is accounted for.
    const total =
      fast.resolved.stats.resolvedMedium +
      fast.resolved.stats.resolvedLow +
      fast.resolved.stats.unresolved;
    expect(fast.resolved.stats.totalCallSites).toBe(total);
  });

  it('separates the cache: fast and exact cacheKeys differ for the same tsconfig', async () => {
    const { exact, fast } = await buildBothTiers(dir);
    expect(fast.cacheKey).not.toBe(exact.cacheKey);
    expect(fast.cacheKey).toContain('-fast-');
    expect(exact.cacheKey).toContain('-exact-');
  });

  it('fast recovers the cross-file (imported) and same-file call edges', async () => {
    const { fast } = await buildBothTiers(dir);
    const targets = new Set(allEdges(fast.resolved.edgesByOwner).flatMap((e) => e.to));
    // main → helper (imported, cross-file) and the same-file chain all resolve.
    expect(targets.size).toBeGreaterThanOrEqual(3);
  });
});
