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
