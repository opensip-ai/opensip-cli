/**
 * Tests for the orchestrator (cli/orchestrate.ts).
 *
 * Drives the full pipeline against a small fixture project on the
 * filesystem, exercising the cache miss → write → hit cycle.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runGraph } from '../../cli/orchestrate.js';

const FIXTURE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'Node16',
    moduleResolution: 'Node16',
    lib: ['ES2022'],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    rootDir: '.',
  },
  include: ['**/*.ts'],
});

function setupFixture(dir: string, files: Readonly<Record<string, string>>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tsconfig.json'), FIXTURE_TSCONFIG, 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(p.slice(0, Math.max(0, p.lastIndexOf('/'))), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
}

describe('runGraph orchestrator', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-orch-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('first run is a cache miss; second run is a cache hit', async () => {
    setupFixture(dir, {
      'index.ts': `export function main(): number { return helper(); }\nfunction helper(): number { return 1; }\n`,
    });
    const first = await runGraph({ cwd: dir });
    expect(first.cacheHit).toBe(false);
    expect(first.catalog).not.toBeNull();
    expect(first.indexes).not.toBeNull();
    expect(first.resolutionStats).not.toBeNull();

    const second = await runGraph({ cwd: dir });
    expect(second.cacheHit).toBe(true);
    expect(second.resolutionStats).toBeNull(); // not recomputed on hit
    expect(second.catalog).not.toBeNull();
  });

  it('honors noCache=true to force a rebuild even when a valid cache exists', async () => {
    setupFixture(dir, {
      'index.ts': `export function main(): number { return helper(); }\nfunction helper(): number { return 1; }\n`,
    });
    await runGraph({ cwd: dir });
    const second = await runGraph({ cwd: dir, noCache: true });
    expect(second.cacheHit).toBe(false);
    expect(second.resolutionStats).not.toBeNull();
  });

  it('produces signals from the default rules registry', async () => {
    setupFixture(dir, {
      'index.ts': `function unused(): number { return 7; }\nexport function main(): void { return; }\n`,
    });
    const result = await runGraph({ cwd: dir });
    // unused has no callers → orphan
    expect(result.signals.some((s) => s.ruleId === 'graph:orphan-subtree')).toBe(true);
  });

  it('honors a caller-supplied rules override (empty rules → no signals)', async () => {
    setupFixture(dir, {
      'index.ts': `function unused(): number { return 7; }\nexport function main(): void { return; }\n`,
    });
    const result = await runGraph({ cwd: dir, rules: [] });
    expect(result.signals).toHaveLength(0);
  });

  it('honors a tsConfigPath override (proves --package wiring will work end-to-end)', async () => {
    // Create a project with two sibling sub-packages, each with its own
    // tsconfig. Run the orchestrator scoped to the inner one and assert
    // that only files from that package appear in the catalog.
    setupFixture(dir, {
      'packages/a/index.ts': `export function fromA(): number { return 1; }\n`,
      'packages/b/index.ts': `export function fromB(): number { return 2; }\n`,
    });
    const innerTsconfig = join(dir, 'packages', 'a', 'tsconfig.json');
    writeFileSync(
      innerTsconfig,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'Node16',
          moduleResolution: 'Node16',
          strict: true,
          rootDir: '.',
        },
        include: ['**/*.ts'],
      }),
      'utf8',
    );
    const result = await runGraph({
      cwd: join(dir, 'packages', 'a'),
      tsConfigPath: innerTsconfig,
    });
    expect(result.catalog).not.toBeNull();
    const filePaths = new Set<string>();
    for (const name of Object.keys(result.catalog!.functions)) {
      const occs = result.catalog!.functions[name];
      if (occs) for (const o of occs) filePaths.add(o.filePath);
    }
    // Only files under the scoped package should appear; the sibling
    // package's index.ts must not be in the catalog.
    for (const fp of filePaths) {
      expect(fp.startsWith('../b/')).toBe(false);
    }
  });

  it('incremental rebuild produces a catalog identical to a full rebuild after a single-file edit (Wave 4)', async () => {
    // Three sibling files. First run populates the cache. Second run
    // (after editing only b.ts) should take the incremental path and
    // produce a catalog identical to what --no-cache would give.
    setupFixture(dir, {
      'a.ts': `export function fromA(): number { return 1; }\n`,
      'b.ts': `export function fromB(): number { return 2; }\n`,
      'c.ts': `import { fromA } from './a.js';\nimport { fromB } from './b.js';\nexport function main(): number { return fromA() + fromB(); }\n`,
    });
    await runGraph({ cwd: dir });

    // Wait long enough for mtimeMs to differ. macOS mtime resolution
    // is millisecond-grained but JS clock readings can collide if the
    // file is touched in the same tick.
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(
      join(dir, 'b.ts'),
      `export function fromB(): number { return 2; }\nexport function fromBExtra(): string { return 'new'; }\n`,
      'utf8',
    );

    const incremental = await runGraph({ cwd: dir });
    expect(incremental.cacheHit).toBe(false); // incremental, not a hit
    expect(incremental.resolutionStats).not.toBeNull();
    expect(incremental.catalog).not.toBeNull();

    // Compare against a clean --no-cache rebuild.
    const fullRebuild = await runGraph({ cwd: dir, noCache: true });
    expect(fullRebuild.catalog).not.toBeNull();

    // The function name set should match exactly (added function
    // appears, removed/edited functions reflect the new state).
    const incrementalNames = Object.keys(incremental.catalog!.functions).sort();
    const fullNames = Object.keys(fullRebuild.catalog!.functions).sort();
    expect(incrementalNames).toEqual(fullNames);
    // The new function appears in both.
    expect(incrementalNames).toContain('fromBExtra');
  });

  it('cache write failure is non-fatal', async () => {
    setupFixture(dir, {
      'index.ts': `export function x(): number { return 1; }\n`,
    });
    // Place a regular file where the orchestrator wants to create the
    // cache *parent* directory. mkdirSync(recursive=true) tolerates
    // ENOTDIR mid-path by throwing — the orchestrator catches.
    const cachePath = join(dir, 'opensip-tools', '.runtime', 'cache');
    mkdirSync(join(dir, 'opensip-tools', '.runtime'), { recursive: true });
    writeFileSync(cachePath, 'block', 'utf8');
    const result = await runGraph({ cwd: dir });
    // Run still produced a catalog; cache simply could not be written.
    expect(result.catalog).not.toBeNull();
  });
});
