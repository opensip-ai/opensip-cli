import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverManifestFacts, packageFacts } from './inventory-manifests.js';
import { DEFAULT_INVENTORY_LIMITS, MAX_WORKSPACE_PATTERNS } from './types.js';

import type {
  BoundedTargetResolution,
  BoundedTargetResolutionOptions,
  BoundedTargetResolver,
  TargetView,
} from '@opensip-cli/core';

const roots: string[] = [];

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-manifest-edges-')));
  roots.push(root);
  return root;
}

function writeText(root: string, relativePath: string, contents: string): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function writeManifest(root: string, relativeDirectory: string, value: unknown): string {
  return writeText(
    root,
    join(relativeDirectory === '.' ? '' : relativeDirectory, 'package.json'),
    JSON.stringify(value),
  );
}

class SignalExcludes implements BoundedTargetResolver {
  readonly globalExcludes = ['**/*.ignored'];

  getByName(): TargetView | undefined {
    return undefined;
  }

  getAll(): readonly TargetView[] {
    return [];
  }

  getByTag(): readonly TargetView[] {
    return [];
  }

  has(): boolean {
    return false;
  }

  resolveTargets(): readonly string[] {
    return [];
  }

  resolveTargetsBounded(
    _names: readonly string[],
    _rootDir: string,
    options: BoundedTargetResolutionOptions,
  ): Promise<BoundedTargetResolution> {
    return Promise.resolve({
      files: [],
      capped: false,
      cancelled: options.signal?.aborted === true,
    });
  }

  applyGlobalExcludes(files: readonly string[]): readonly string[] {
    return files;
  }

  applyGlobalExcludesBounded(
    files: readonly string[],
    _rootDir: string,
    options: BoundedTargetResolutionOptions,
  ): Promise<BoundedTargetResolution> {
    return Promise.resolve({
      files: files.slice(0, options.maxResults),
      capped: files.length > options.maxResults,
      cancelled: options.signal?.aborted === true,
    });
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('discoverManifestFacts edge paths', () => {
  it('merges pnpm workspace patterns and records the authored workspace cap', async () => {
    const root = tempRoot();
    writeManifest(root, '.', { name: 'root', workspaces: ['apps/*'] });
    const patterns = Array.from(
      { length: MAX_WORKSPACE_PATTERNS },
      (_, index) => `packages/p-${String(index).padStart(3, '0')}`,
    );
    writeText(
      root,
      'pnpm-workspace.yaml',
      `packages:\n${patterns.map((pattern) => `  - '${pattern}'\n`).join('')}`,
    );

    const discovery = await discoverManifestFacts(
      root,
      DEFAULT_INVENTORY_LIMITS,
      undefined,
      undefined,
    );

    expect(discovery.reasons).toContain('manifest-workspace-cap-reached');
    expect(discovery.facts[0]?.workspacePatterns.length).toBeLessThanOrEqual(
      MAX_WORKSPACE_PATTERNS,
    );
  });

  it('retains the deterministic package prefix when the package budget is exceeded', async () => {
    const root = tempRoot();
    writeManifest(root, '.', { name: 'root', workspaces: ['packages/*'] });
    writeManifest(root, 'packages/zzz', { name: 'zzz' });
    writeManifest(root, 'packages/aaa', { name: 'aaa' });
    writeManifest(root, 'packages/mmm', { name: 'mmm' });

    const discovery = await discoverManifestFacts(
      root,
      { ...DEFAULT_INVENTORY_LIMITS, packages: 2 },
      undefined,
      undefined,
    );

    expect(discovery.facts.map((fact) => fact.name).sort()).toEqual(['aaa', 'root']);
    expect(discovery.reasons).toContain('package-cap-reached');
  });

  it('reports parse and size failures while continuing discovery', async () => {
    const root = tempRoot();
    writeManifest(root, '.', { name: 'root' });
    writeText(root, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
    writeText(root, 'packages/broken/package.json', '{');
    writeText(
      root,
      'packages/huge/package.json',
      JSON.stringify({ name: 'huge', pad: 'x'.repeat(2 * 1024 * 1024) }),
    );
    writeManifest(root, 'packages/ok', { name: 'ok' });

    const discovery = await discoverManifestFacts(
      root,
      { ...DEFAULT_INVENTORY_LIMITS, manifestBytes: 1024 },
      undefined,
      undefined,
    );

    expect(discovery.reasons).toEqual(
      expect.arrayContaining(['manifest-parse-failed', 'manifest-too-large']),
    );
    expect(discovery.facts.map((fact) => fact.name).sort()).toEqual(['ok', 'root']);
  });

  it('qualifies cancelled workspace discovery and skips remaining roots', async () => {
    const root = tempRoot();
    writeManifest(root, '.', { name: 'root', workspaces: ['packages/*'] });
    for (let index = 0; index < 80; index += 1) {
      writeManifest(root, `packages/p-${String(index).padStart(3, '0')}`, {
        name: `p-${String(index)}`,
      });
    }
    let checks = 0;
    const signal = {
      get aborted() {
        checks += 1;
        return checks > 15;
      },
    } as AbortSignal;

    const discovery = await discoverManifestFacts(
      root,
      DEFAULT_INVENTORY_LIMITS,
      signal,
      new SignalExcludes(),
    );

    expect(discovery.reasons).toContain('inventory-cancelled');
    expect(discovery.facts.length).toBeLessThan(81);
  });

  it('omits a broken package.json symlink without retaining its package fact', async () => {
    const root = tempRoot();
    writeManifest(root, '.', { name: 'root', workspaces: ['packages/*'] });
    writeManifest(root, 'packages/live', { name: 'live' });
    const ghostDir = join(root, 'packages/ghost');
    mkdirSync(ghostDir, { recursive: true });
    symlinkSync(join(root, 'packages/missing/package.json'), join(ghostDir, 'package.json'));

    const discovery = await discoverManifestFacts(
      root,
      DEFAULT_INVENTORY_LIMITS,
      undefined,
      undefined,
    );

    expect(discovery.facts.map((fact) => fact.name).sort()).toEqual(['live', 'root']);
    expect(discovery.reasons.some((reason) => reason.startsWith('manifest-'))).toBe(true);
  });

  it('rejects root manifests that escape the project via symlink', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeManifest(outside, '.', { name: 'escaped' });
    symlinkSync(join(outside, 'package.json'), join(root, 'package.json'));
    writeText(root, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
    writeManifest(root, 'packages/safe', { name: 'safe' });

    const discovery = await discoverManifestFacts(
      root,
      DEFAULT_INVENTORY_LIMITS,
      undefined,
      undefined,
    );

    expect(discovery.facts.map((fact) => fact.name)).toEqual(['safe']);
    expect(discovery.reasons).toContain('manifest-outside-root');
  });

  it('deduplicates package names across root and workspace members', async () => {
    const root = tempRoot();
    writeManifest(root, '.', { name: 'dup', workspaces: ['packages/*'] });
    writeManifest(root, 'packages/a', { name: 'dup' });
    writeManifest(root, 'packages/b', { name: 'unique' });

    const discovery = await discoverManifestFacts(
      root,
      DEFAULT_INVENTORY_LIMITS,
      undefined,
      undefined,
    );

    expect(discovery.facts.map((fact) => fact.name)).toEqual(['dup', 'unique']);
    expect(discovery.reasons).toContain('package-name-duplicate');
  });

  it('projects package facts with frozen provenance', () => {
    const facts = packageFacts([
      {
        name: 'app',
        root: 'packages/app',
        private: false,
        exports: ['.'],
        bins: ['app'],
        verificationCommands: [],
        workspacePatterns: [],
        reasonCodes: [],
        packageManager: undefined,
      },
    ]);

    expect(facts).toEqual([
      {
        name: 'app',
        root: 'packages/app',
        private: false,
        exports: ['.'],
        bins: ['app'],
        verificationCommands: [],
        provenance: [{ source: 'manifest', detail: 'package.json' }],
      },
    ]);
    expect(Object.isFrozen(facts[0])).toBe(true);
  });

  it('flushes discovery batches once the retained batch budget is full', async () => {
    const root = tempRoot();
    writeManifest(root, '.', { name: 'root', workspaces: ['packages/*'] });
    for (let index = 0; index < 70; index += 1) {
      writeManifest(root, `packages/p-${String(index).padStart(3, '0')}`, {
        name: `p-${String(index).padStart(3, '0')}`,
      });
    }

    const discovery = await discoverManifestFacts(
      root,
      DEFAULT_INVENTORY_LIMITS,
      undefined,
      undefined,
    );

    expect(discovery.facts.length).toBe(71);
    expect(discovery.reasons).toEqual([]);
  });

  it('records filter re-canonicalization failures when a retained path vanishes', async () => {
    const root = tempRoot();
    writeManifest(root, '.', { name: 'root', workspaces: ['packages/*'] });
    writeManifest(root, 'packages/live', { name: 'live' });
    writeManifest(root, 'packages/ghost', { name: 'ghost' });

    class DeletingExcludes extends SignalExcludes {
      override async applyGlobalExcludesBounded(
        files: readonly string[],
        _rootDir: string,
        options: BoundedTargetResolutionOptions,
      ): Promise<BoundedTargetResolution> {
        for (const file of files) {
          if (file.includes(`${join('packages', 'ghost')}`)) {
            rmSync(file, { force: true });
          }
        }
        return {
          files: files.slice(0, options.maxResults),
          capped: false,
          cancelled: false,
        };
      }
    }

    const discovery = await discoverManifestFacts(
      root,
      DEFAULT_INVENTORY_LIMITS,
      undefined,
      new DeletingExcludes(),
    );

    expect(discovery.reasons).toContain('manifest-read-failed');
    expect(discovery.facts.map((fact) => fact.name).sort()).toEqual(['live', 'root']);
  });

  it('stops collecting workspace facts once cancellation is observed mid-loop', async () => {
    const root = tempRoot();
    writeManifest(root, '.', { name: 'root', workspaces: ['packages/*'] });
    for (let index = 0; index < 70; index += 1) {
      writeManifest(root, `packages/p-${String(index).padStart(3, '0')}`, {
        name: `p-${String(index).padStart(3, '0')}`,
      });
    }
    let checks = 0;
    const signal = {
      get aborted() {
        checks += 1;
        // Discovery visits many paths; cancel after the first batch is retained so
        // fact materialization observes cancellation on a later root.
        return checks > 400;
      },
    } as AbortSignal;

    const discovery = await discoverManifestFacts(
      root,
      DEFAULT_INVENTORY_LIMITS,
      signal,
      undefined,
    );

    expect(discovery.reasons).toContain('inventory-cancelled');
    expect(discovery.facts.length).toBeLessThan(71);
  });

  it('propagates cancelled and outside-root package read failures', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeManifest(root, '.', { name: 'root', workspaces: ['packages/*'] });
    writeManifest(root, 'packages/ok', { name: 'ok' });
    writeManifest(outside, 'escaped', { name: 'escaped' });
    mkdirSync(join(root, 'packages/linked'), { recursive: true });
    // Directory symlink is not followed by the walker; create a package whose
    // package.json is a file symlink to an outside-root manifest instead.
    symlinkSync(join(outside, 'escaped/package.json'), join(root, 'packages/linked/package.json'));

    const controller = new AbortController();
    controller.abort();
    const cancelled = await discoverManifestFacts(
      root,
      DEFAULT_INVENTORY_LIMITS,
      controller.signal,
      undefined,
    );
    expect(cancelled.reasons).toContain('inventory-cancelled');

    const discovery = await discoverManifestFacts(
      root,
      DEFAULT_INVENTORY_LIMITS,
      undefined,
      undefined,
    );
    expect(discovery.facts.map((fact) => fact.name).sort()).toEqual(['ok', 'root']);
    expect(
      discovery.reasons.some(
        (reason) => reason === 'manifest-outside-root' || reason === 'manifest-read-failed',
      ),
    ).toBe(true);
  });
});
