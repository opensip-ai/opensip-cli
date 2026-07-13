import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildProjectInventory } from './inventory.js';
import {
  MAX_MANIFEST_ENTRIES_PER_DIRECTORY,
  walkManifestFilesystem,
} from './manifest-filesystem-walk.js';

import type {
  BoundedTargetResolution,
  BoundedTargetResolutionOptions,
  BoundedTargetResolver,
  TargetView,
} from '@opensip-cli/core';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'opensip-manifest-discovery-'));
  roots.push(root);
  return root;
}

function writeText(root: string, relativePath: string, contents = ''): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function writeManifest(root: string, relativeDirectory: string, value: unknown): string {
  return writeText(root, join(relativeDirectory, 'package.json'), JSON.stringify(value));
}

class ManifestGlobalExcludes implements BoundedTargetResolver {
  readonly globalExcludes = ['packages/excluded/**'];

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
    return files.filter((file) => !file.replaceAll('\\', '/').includes('/packages/excluded/'));
  }

  applyGlobalExcludesBounded(
    files: readonly string[],
    _rootDir: string,
    options: BoundedTargetResolutionOptions,
  ): Promise<BoundedTargetResolution> {
    const retained = this.applyGlobalExcludes(files);
    return Promise.resolve({
      files: retained.slice(0, options.maxResults),
      capped: retained.length > options.maxResults,
      cancelled: options.signal?.aborted === true,
    });
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bounded manifest discovery', () => {
  it('rejects package.json root escapes and never follows a workspace directory symlink', async () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    writeManifest(root, '.', {
      name: 'root',
      workspaces: ['../../**', '/outside/**', 'packages/**'],
    });
    writeManifest(root, 'packages/safe', { name: 'safe' });
    writeManifest(outside, 'secret', { name: 'outside-secret' });
    mkdirSync(join(root, 'packages'), { recursive: true });
    symlinkSync(outside, join(root, 'packages/linked-outside'), 'dir');

    const offered: string[] = [];
    await walkManifestFilesystem(
      root,
      12,
      () => true,
      (candidate) => {
        offered.push(candidate.packageRoot);
      },
    );

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
    });

    expect(inventory.snapshot.packages.map((pkg) => pkg.name)).toEqual(['root', 'safe']);
    expect(inventory.snapshot.project.workspacePatterns).toEqual(['packages/**']);
    expect(inventory.snapshot.coverage.reasonCodes).toContain('workspace-pattern-invalid');
    expect(JSON.stringify(inventory.snapshot)).not.toContain('outside-secret');
    expect(offered.some((candidate) => candidate.includes('linked-outside'))).toBe(false);
  });

  it('uses the same hostile-pattern boundary for pnpm workspace declarations', async () => {
    const root = temporaryRoot();
    writeManifest(root, '.', { name: 'root' });
    writeText(
      root,
      'pnpm-workspace.yaml',
      "packages:\n  - '../../**'\n  - '{packages,../outside}/**'\n  - 'packages/*'\n",
    );
    writeManifest(root, 'packages/safe', { name: 'safe' });

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
    });

    expect(inventory.snapshot.packages.map((pkg) => pkg.name)).toEqual(['root', 'safe']);
    expect(inventory.snapshot.project.workspacePatterns).toEqual(['packages/*']);
    expect(inventory.snapshot.coverage.reasonCodes).toContain('workspace-pattern-invalid');
  });

  it('prunes impossible workspace prefixes before a hostile unrelated directory', async () => {
    const root = temporaryRoot();
    writeManifest(root, '.', { name: 'root', workspaces: ['packages/*'] });
    writeManifest(root, 'packages/app', { name: 'app' });
    for (let index = 0; index <= MAX_MANIFEST_ENTRIES_PER_DIRECTORY; index += 1) {
      writeText(root, `vendor/wide/${String(index).padStart(5, '0')}.txt`);
    }

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
    });

    expect(inventory.snapshot.packages.map((pkg) => pkg.name)).toEqual(['root', 'app']);
    expect(inventory.snapshot.coverage.reasonCodes).not.toContain('package-discovery-cap-reached');
  });

  it('marks discovery partial when an eligible directory exceeds its retained-entry cap', async () => {
    const root = temporaryRoot();
    writeManifest(root, '.', { name: 'root', workspaces: ['eligible/**'] });
    for (let index = 0; index <= MAX_MANIFEST_ENTRIES_PER_DIRECTORY; index += 1) {
      writeText(root, `eligible/wide/${String(index).padStart(5, '0')}.txt`);
    }

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
    });

    expect(inventory.snapshot.packages.map((pkg) => pkg.name)).toEqual(['root']);
    expect(inventory.snapshot.coverage.reasonCodes).toContain('package-discovery-cap-reached');
  });

  it('observes cancellation during a no-match directory read', async () => {
    const root = temporaryRoot();
    for (let index = 0; index < 512; index += 1) {
      writeText(root, `unmatched/${String(index).padStart(4, '0')}.txt`);
    }
    let checks = 0;
    const signal = {
      get aborted() {
        checks += 1;
        return checks > 80;
      },
    } as AbortSignal;

    const result = await walkManifestFilesystem(
      root,
      12,
      () => true,
      () => undefined,
      signal,
    );

    expect(result.cancelled).toBe(true);
    expect(result.capped).toBe(false);
    expect(result.metrics.visitedEntries).toBeLessThan(512);
  });

  it('opens no directory for an already-aborted walk', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await walkManifestFilesystem(
      join(temporaryRoot(), 'does-not-exist'),
      12,
      () => true,
      () => undefined,
      controller.signal,
    );

    expect(result).toMatchObject({
      cancelled: true,
      capped: false,
      readFailed: false,
      metrics: { visitedDirectories: 0, visitedEntries: 0 },
    });
  });

  it('does not walk workspaces after the root consumes the package budget', async () => {
    const root = temporaryRoot();
    writeManifest(root, '.', { name: 'root', workspaces: ['eligible/**'] });
    for (let index = 0; index <= MAX_MANIFEST_ENTRIES_PER_DIRECTORY; index += 1) {
      writeText(root, `eligible/wide/${String(index).padStart(5, '0')}.txt`);
    }

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      limits: { packages: 1 },
    });

    expect(inventory.snapshot.packages.map((pkg) => pkg.name)).toEqual(['root']);
    expect(inventory.snapshot.coverage.reasonCodes).not.toContain('package-discovery-cap-reached');
  });

  it('marks depth truncation and skips nested OpenSIP runtime manifests', async () => {
    const root = temporaryRoot();
    writeManifest(root, '.', { name: 'root', workspaces: ['**'] });
    writeManifest(root, 'nested/opensip-cli/.runtime/private', { name: 'runtime-private' });
    let directory = 'deep';
    for (let depth = 0; depth < 14; depth += 1) directory += `/d-${String(depth)}`;
    writeManifest(root, directory, { name: 'too-deep' });

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
    });

    expect(inventory.snapshot.packages.map((pkg) => pkg.name)).toEqual(['root']);
    expect(inventory.snapshot.coverage.reasonCodes).toContain('package-discovery-cap-reached');
    expect(JSON.stringify(inventory.snapshot)).not.toContain('runtime-private');
  });

  it('applies bounded global excludes before retaining a discovered manifest', async () => {
    const root = temporaryRoot();
    writeManifest(root, '.', { name: 'root', workspaces: ['packages/*'] });
    writeManifest(root, 'packages/included', { name: 'included' });
    writeManifest(root, 'packages/excluded', {
      name: 'excluded',
      scripts: { test: 'vitest run should-not-leak' },
    });

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets: new ManifestGlobalExcludes(),
    });

    expect(inventory.snapshot.packages.map((pkg) => pkg.name)).toEqual(['root', 'included']);
    expect(JSON.stringify(inventory.snapshot)).not.toContain('should-not-leak');
  });
});
