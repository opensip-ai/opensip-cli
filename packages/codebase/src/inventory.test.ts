import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { projectInventorySnapshotSchema } from '@opensip-cli/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { buildProjectInventory } from './inventory.js';

import type { TargetResolver, TargetView } from '@opensip-cli/core';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'opensip-codebase-inventory-'));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function writeSource(root: string, relativePath: string, contents = 'source'): string {
  const file = join(root, relativePath);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

function target(name: string, extra: Partial<TargetView['config']> = {}): TargetView {
  return {
    config: {
      name,
      description: name,
      include: ['**/*'],
      exclude: [],
      ...extra,
    },
  };
}

class FakeTargets implements TargetResolver {
  readonly globalExcludes = ['**/*.ignored.ts'];
  applyCalls = 0;
  readonly appliedFiles: string[][] = [];

  constructor(
    private readonly definitions: readonly TargetView[],
    private readonly files: Readonly<Record<string, readonly string[]>>,
  ) {}

  getByName(name: string): TargetView | undefined {
    return this.definitions.find((candidate) => candidate.config.name === name);
  }

  getAll(): readonly TargetView[] {
    return this.definitions;
  }

  getByTag(tag: string): readonly TargetView[] {
    return this.definitions.filter((candidate) => candidate.config.tags?.includes(tag));
  }

  has(name: string): boolean {
    return this.getByName(name) !== undefined;
  }

  resolveTargets(names: readonly string[]): readonly string[] {
    return names.flatMap((name) => this.files[name] ?? []);
  }

  applyGlobalExcludes(files: readonly string[]): readonly string[] {
    this.applyCalls += 1;
    this.appliedFiles.push([...files]);
    return files.filter((file) => !file.endsWith('.ignored.ts'));
  }
}

class ThrowingTargets extends FakeTargets {
  override resolveTargets(): readonly string[] {
    throw new Error('fixture resolution failure');
  }
}

class ThrowingExcludesTargets extends FakeTargets {
  override applyGlobalExcludes(): readonly string[] {
    throw new Error('fixture exclude failure');
  }
}

class ManifestExcludingTargets extends FakeTargets {
  override applyGlobalExcludes(files: readonly string[]): readonly string[] {
    this.applyCalls += 1;
    this.appliedFiles.push([...files]);
    return files.filter((file) => !file.replaceAll('\\', '/').includes('/packages/excluded/'));
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('buildProjectInventory', () => {
  it('builds deterministic frozen metadata facts from manifests and target resolution', async () => {
    const root = tempRoot();
    writeJson(join(root, 'package.json'), {
      name: '@example/root',
      private: true,
      packageManager: 'pnpm@11',
      workspaces: ['packages/*'],
      scripts: { test: 'pnpm test' },
    });
    writeJson(join(root, 'packages/leaf/package.json'), {
      name: '@example/leaf',
      scripts: { 'test:unit': 'vitest run' },
    });
    writeSource(root, 'pnpm-lock.yaml', 'lockfileVersion: 9');
    writeSource(root, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'");
    const rootFile = writeSource(root, 'src/main.ts', 'DO-NOT-RETAIN-root');
    const leafTest = writeSource(root, 'packages/leaf/src/main.test.ts', 'DO-NOT-RETAIN-test');
    const ignored = writeSource(root, 'src/generated.ignored.ts');
    const targets = new FakeTargets(
      [
        target('tests', { tags: ['test'], languages: ['typescript'] }),
        target('production', {
          concerns: ['backend'],
          languages: ['typescript'],
        }),
      ],
      { production: [rootFile, ignored], tests: [leafTest] },
    );
    const languageEvidenceSupport = new Map([
      [
        'typescript',
        {
          callable: 'supported' as const,
          declaration: 'supported' as const,
          reference: 'supported' as const,
        },
      ],
    ]);

    const first = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg:one',
      targets,
      languageEvidenceSupport,
    });
    const second = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg:one',
      targets,
      languageEvidenceSupport,
    });

    expect(first.snapshot).toEqual(second.snapshot);
    expect(first.snapshot.metadataIdentity).toMatch(/^m1:[a-f0-9]{64}$/u);
    expect(first.snapshot.snapshotId).toMatch(/^i1:[a-f0-9]{64}$/u);
    expect(first.snapshot.project).toEqual({
      packageManager: 'pnpm@11',
      workspacePatterns: ['packages/*'],
      languages: ['typescript'],
      fileCount: 6,
      packageCount: 2,
      configIdentity: 'cfg:one',
    });
    expect(first.snapshot.packages.map((pkg) => [pkg.root, pkg.name])).toEqual([
      ['.', '@example/root'],
      ['packages/leaf', '@example/leaf'],
    ]);
    expect(first.snapshot.files.map((file) => file.path)).toEqual([
      'package.json',
      'packages/leaf/package.json',
      'packages/leaf/src/main.test.ts',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'src/main.ts',
    ]);
    expect(first.fileByPath.get('package.json')).toMatchObject({
      roles: ['configuration'],
      packageName: '@example/root',
      targets: [],
      provenance: expect.arrayContaining([{ source: 'manifest', detail: 'package.json' }]),
    });
    expect(first.fileByPath.get('packages/leaf/package.json')).toMatchObject({
      roles: ['configuration'],
      packageName: '@example/leaf',
      targets: [],
    });
    expect(first.fileByPath.get('pnpm-lock.yaml')).toMatchObject({
      roles: ['build', 'configuration'],
      provenance: expect.arrayContaining([{ source: 'convention', detail: 'project-lockfile' }]),
    });
    expect(first.fileByPath.get('pnpm-workspace.yaml')).toMatchObject({
      roles: ['configuration'],
      provenance: expect.arrayContaining([{ source: 'convention', detail: 'workspace-manifest' }]),
    });
    expect(first.fileByPath.get('packages/leaf/src/main.test.ts')).toMatchObject({
      roles: ['test'],
      packageName: '@example/leaf',
      targets: ['tests'],
      languages: ['typescript'],
      evidenceSupport: {
        callable: 'supported',
        declaration: 'supported',
        reference: 'supported',
      },
    });
    expect(first.fileByPath.get('src/main.ts')).toMatchObject({
      roles: ['production'],
      packageName: '@example/root',
      languages: ['typescript'],
    });
    expect(first.packageByRoot.get('.')).toMatchObject({
      name: '@example/root',
    });
    expect(first.manifestByRoot.get('packages/leaf')?.verificationCommands[0]?.tier).toBe(
      'focused',
    );
    expect(targets.applyCalls).toBeGreaterThan(0);
    expect(
      targets.appliedFiles.some((files) => files.some((file) => file.endsWith('pnpm-lock.yaml'))),
    ).toBe(true);
    expect(JSON.stringify(first.snapshot)).not.toContain('DO-NOT-RETAIN');
    expect(Object.isFrozen(first.snapshot)).toBe(true);
    expect(Object.isFrozen(first.snapshot.files[0])).toBe(true);
    expect(projectInventorySnapshotSchema.safeParse(first.snapshot).success).toBe(true);
  });

  it('changes metadata identity when relevant file metadata changes', async () => {
    const root = tempRoot();
    writeJson(join(root, 'package.json'), { name: 'root' });
    const file = writeSource(root, 'src/a.ts');
    const targets = new FakeTargets([target('source', { languages: ['typescript'] })], {
      source: [file],
    });
    const before = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
    });
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    const after = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
    });

    expect(after.snapshot.metadataIdentity).not.toBe(before.snapshot.metadataIdentity);
    expect(after.fileByPath.get('src/a.ts')?.modifiedMs).not.toBe(
      before.fileByPath.get('src/a.ts')?.modifiedMs,
    );
  });

  it('reports hard file and membership caps with deterministic partial output', async () => {
    const root = tempRoot();
    const alpha = writeSource(root, 'src/a.ts');
    const beta = writeSource(root, 'src/b.ts');
    const targets = new FakeTargets(
      [target('alpha', { languages: ['typescript'] }), target('beta', { tags: ['test'] })],
      { alpha: [alpha, beta], beta: [alpha] },
    );
    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
      limits: { files: 1, targetsPerFile: 1 },
    });

    expect(inventory.snapshot.files).toHaveLength(1);
    expect(inventory.snapshot.files[0]?.path).toBe('src/a.ts');
    expect(inventory.snapshot.coverage).toMatchObject({
      status: 'partial',
      observed: 1,
    });
    expect(inventory.snapshot.coverage.reasonCodes).toContain('file-cap-reached');
  });

  it('omits invalid filesystem metadata as qualified partial evidence', async () => {
    const root = tempRoot();
    const valid = writeSource(root, 'src/valid.ts');
    const beforeEpoch = writeSource(root, 'src/before-epoch.ts');
    utimesSync(beforeEpoch, new Date(-1000), new Date(-1000));
    const targets = new FakeTargets([target('source', { languages: ['typescript'] })], {
      source: [valid, beforeEpoch],
    });

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
    });

    expect(inventory.snapshot.files.map((file) => file.path)).toEqual(['src/valid.ts']);
    expect(inventory.snapshot.coverage).toMatchObject({ status: 'partial', observed: 1 });
    expect(inventory.snapshot.coverage.reasonCodes).toContain('file-metadata-invalid');
    expect(projectInventorySnapshotSchema.safeParse(inventory.snapshot).success).toBe(true);
  });

  it('truncates on stable fact boundaries before the serialized inventory budget', async () => {
    const root = tempRoot();
    writeJson(join(root, 'package.json'), { name: 'root' });
    const files = Array.from({ length: 100 }, (_, index) =>
      writeSource(root, `src/file-${String(index).padStart(3, '0')}.ts`),
    );
    const targets = new FakeTargets([target('source', { languages: ['typescript'] })], {
      source: files,
    });
    const first = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
      limits: { serializedBytes: 4096 },
    });
    const second = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
      limits: { serializedBytes: 4096 },
    });

    expect(Buffer.byteLength(JSON.stringify(first.snapshot), 'utf8')).toBeLessThanOrEqual(4096);
    expect(first.snapshot.files.length).toBeLessThan(files.length);
    expect(first.snapshot.coverage.reasonCodes).toContain('inventory-byte-cap-reached');
    expect(first.snapshot).toEqual(second.snapshot);
  });

  it('caps repeated target membership without duplicating a target', async () => {
    const root = tempRoot();
    writeJson(join(root, 'package.json'), { name: 'root' });
    const file = writeSource(root, 'src/a.ts');
    const targets = new FakeTargets(
      [
        target('alpha', { languages: ['typescript'] }),
        target('beta', { tags: ['test'] }),
        target('gamma', { concerns: ['documentation'] }),
      ],
      { alpha: [file, file], beta: [file], gamma: [file] },
    );
    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
      limits: { targetsPerFile: 2 },
    });

    expect(inventory.fileByPath.get('src/a.ts')?.targets).toEqual(['alpha', 'beta']);
    expect(inventory.snapshot.coverage.reasonCodes).toEqual(['target-membership-cap-reached']);
  });

  it('omits unsafe target names and language memberships as qualified partial evidence', async () => {
    const root = tempRoot();
    const file = writeSource(root, 'src/a.ts');
    const targets = new FakeTargets(
      [
        target('x'.repeat(129), { languages: ['typescript'] }),
        target('safe', { languages: ['typescript', `bad\nlanguage`, 'x'.repeat(129)] }),
      ],
      { safe: [file] },
    );
    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
    });

    expect(inventory.snapshot.files[0]).toMatchObject({
      targets: ['safe'],
      languages: ['typescript'],
      evidenceSupport: {
        callable: 'unknown',
        declaration: 'unknown',
        reference: 'unknown',
      },
    });
    expect(inventory.snapshot.coverage.reasonCodes).toEqual([
      'target-language-invalid',
      'target-name-invalid',
    ]);
  });

  it('reports package discovery and manifest projection failures without throwing', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeJson(join(root, 'package.json'), { name: 'root', workspaces: ['packages/*'] });
    mkdirSync(join(root, 'packages/bad'), { recursive: true });
    writeFileSync(join(root, 'packages/bad/package.json'), '{bad');
    writeJson(join(root, 'packages/invalid/package.json'), []);
    writeJson(join(root, 'packages/large/package.json'), {
      name: 'large',
      padding: 'x'.repeat(200),
    });
    mkdirSync(join(root, 'packages/linked'), { recursive: true });
    writeJson(join(outside, 'package.json'), { name: 'outside' });
    symlinkSync(join(outside, 'package.json'), join(root, 'packages/linked/package.json'));
    const targets = new FakeTargets([target('source')], { source: [] });

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
      limits: { manifestBytes: 64 },
    });

    expect(inventory.snapshot.packages.map((pkg) => pkg.root)).toEqual(['.']);
    expect(inventory.snapshot.coverage.reasonCodes).toEqual([
      'manifest-invalid',
      'manifest-outside-root',
      'manifest-parse-failed',
      'manifest-too-large',
    ]);
  });

  it('enforces the package count bound before parsing unbounded manifests', async () => {
    const root = tempRoot();
    writeJson(join(root, 'package.json'), { name: 'root', workspaces: ['packages/*'] });
    writeJson(join(root, 'packages/a/package.json'), { name: 'a' });
    const targets = new FakeTargets([target('source')], { source: [] });

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
      limits: { packages: 1 },
    });

    expect(inventory.snapshot.packages).toHaveLength(1);
    expect(inventory.snapshot.packages[0]?.root).toBe('.');
    expect(inventory.snapshot.coverage.reasonCodes).toContain('package-cap-reached');
  });

  it('selects the deterministic root-first/code-point package prefix', async () => {
    const root = tempRoot();
    writeJson(join(root, 'package.json'), { name: 'root', workspaces: ['packages/*'] });
    writeJson(join(root, 'packages/z/package.json'), { name: 'z' });
    writeJson(join(root, 'packages/a/package.json'), { name: 'a' });
    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets: new FakeTargets([target('source')], { source: [] }),
      limits: { packages: 2 },
    });

    expect(inventory.snapshot.packages.map((pkg) => pkg.root)).toEqual(['.', 'packages/a']);
    expect(inventory.snapshot.coverage.reasonCodes).toContain('package-cap-reached');
  });

  it('admits only declared workspace manifests and keeps non-members under the root package', async () => {
    const root = tempRoot();
    writeJson(join(root, 'package.json'), { name: 'root', workspaces: ['packages/*'] });
    writeJson(join(root, 'packages/member/package.json'), { name: 'member' });
    writeJson(join(root, 'examples/demo/package.json'), { name: 'demo' });
    const memberFile = writeSource(root, 'packages/member/src/member.ts');
    const exampleFile = writeSource(root, 'examples/demo/src/demo.ts');
    const targets = new FakeTargets([target('source', { languages: ['typescript'] })], {
      source: [memberFile, exampleFile],
    });

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
    });

    expect(inventory.snapshot.packages.map((pkg) => pkg.name)).toEqual(['root', 'member']);
    expect(inventory.fileByPath.get('packages/member/src/member.ts')?.packageName).toBe('member');
    expect(inventory.fileByPath.get('examples/demo/src/demo.ts')?.packageName).toBe('root');
    expect(inventory.manifestByRoot.has('examples/demo')).toBe(false);
  });

  it('uses pnpm workspace declarations and stops at the manifest discovery budget', async () => {
    const root = tempRoot();
    writeJson(join(root, 'package.json'), { name: 'root' });
    writeSource(root, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
    for (let index = 0; index < 80; index += 1) {
      writeJson(join(root, `packages/p-${String(index).padStart(3, '0')}/package.json`), {
        name: `p-${String(index)}`,
      });
    }

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets: new FakeTargets([target('source')], { source: [] }),
      limits: { packages: 1 },
    });

    expect(inventory.snapshot.packages.map((pkg) => pkg.name)).toEqual(['root']);
    expect(inventory.snapshot.project.workspacePatterns).toEqual(['packages/*']);
    expect(inventory.snapshot.coverage.reasonCodes).toContain('package-discovery-cap-reached');
  });

  it('applies global excludes before emitting package manifests or scripts', async () => {
    const root = tempRoot();
    writeJson(join(root, 'package.json'), { name: 'root' });
    writeJson(join(root, 'packages/excluded/package.json'), {
      name: 'excluded',
      scripts: { test: 'vitest run excluded-secret' },
    });
    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets: new ManifestExcludingTargets([target('source')], { source: [] }),
    });

    expect(inventory.snapshot.packages.map((pkg) => pkg.name)).toEqual(['root']);
    expect(inventory.snapshot.files.map((file) => file.path)).toEqual(['package.json']);
    expect(JSON.stringify(inventory.snapshot)).not.toContain('excluded-secret');
  });

  it('retains bounded unknown languages and explicit per-plane evidence support', async () => {
    const root = tempRoot();
    const file = writeSource(root, 'src/mixed.custom');
    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets: new FakeTargets([target('source', { languages: ['klingon', 'typescript'] })], {
        source: [file],
      }),
      languageEvidenceSupport: new Map([
        [
          'typescript',
          {
            callable: 'supported',
            declaration: 'supported',
            reference: 'supported',
          },
        ],
        [
          'klingon',
          {
            callable: 'unsupported',
            declaration: 'unsupported',
            reference: 'unsupported',
          },
        ],
      ]),
    });

    expect(inventory.snapshot.project).toMatchObject({
      languages: ['klingon', 'typescript'],
      fileCount: 1,
      packageCount: 0,
    });
    expect(inventory.snapshot.files[0]).toMatchObject({
      languages: ['klingon', 'typescript'],
      evidenceSupport: {
        callable: 'supported',
        declaration: 'supported',
        reference: 'supported',
      },
    });
  });

  it('degrades cleanly for empty and throwing target resolvers', async () => {
    const root = tempRoot();
    writeJson(join(root, 'package.json'), { name: 'root' });
    const empty = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets: new FakeTargets([], {}),
    });
    expect(empty.snapshot.coverage).toMatchObject({
      status: 'unavailable',
      reasonCodes: ['targets-empty'],
    });

    const throwing = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets: new ThrowingTargets([target('source')], {}),
    });
    expect(throwing.snapshot.coverage).toMatchObject({
      status: 'partial',
      reasonCodes: ['target-resolution-failed'],
    });
  });

  it('rejects directories as file facts and leaves owner absent without manifests', async () => {
    const root = tempRoot();
    const sourceDirectory = join(root, 'src');
    mkdirSync(sourceDirectory);
    const sourceFile = writeSource(root, 'loose.ts');
    const targets = new FakeTargets([target('source', { languages: ['typescript'] })], {
      source: [root, sourceDirectory, sourceFile],
    });

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
    });

    expect(inventory.snapshot.files).toEqual([expect.objectContaining({ path: 'loose.ts' })]);
    expect(inventory.snapshot.files[0]?.packageName).toBeUndefined();
    expect(inventory.snapshot.coverage.reasonCodes).toEqual([
      'file-not-regular',
      'file-outside-root-or-unreadable',
    ]);
  });

  it('observes cancellation between inventory batches', async () => {
    const root = tempRoot();
    writeJson(join(root, 'package.json'), { name: 'root' });
    const files = Array.from({ length: 256 }, (_, index) =>
      writeSource(root, `src/file-${String(index).padStart(3, '0')}.ts`),
    );
    const targets = new FakeTargets([target('source')], { source: files });
    const controller = new AbortController();
    const pending = buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
      signal: controller.signal,
    });
    setImmediate(() => controller.abort());
    const inventory = await pending;

    expect(inventory.snapshot.coverage.reasonCodes).toContain('inventory-cancelled');
    expect(controller.signal.aborted).toBe(true);
  });

  it('stops manifest discovery when cancellation is observed during root enumeration', async () => {
    const root = tempRoot();
    writeJson(join(root, 'package.json'), { name: 'root' });
    let reads = 0;
    const signal = {
      get aborted() {
        reads += 1;
        return reads >= 2;
      },
    } as AbortSignal;

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets: new FakeTargets([target('source')], { source: [] }),
      signal,
    });

    expect(inventory.snapshot.coverage.reasonCodes).toContain('inventory-cancelled');
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it('fails closed when structural marker canonicalization or global exclusion fails', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeJson(join(root, 'package.json'), { name: 'root' });
    const outsideLock = writeSource(outside, 'pnpm-lock.yaml');
    symlinkSync(outsideLock, join(root, 'pnpm-lock.yaml'));
    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets: new ThrowingExcludesTargets([target('source')], { source: [] }),
    });

    expect(inventory.snapshot.files).toEqual([]);
    expect(inventory.snapshot.coverage.reasonCodes).toEqual([
      'file-outside-root-or-unreadable',
      'global-exclude-filter-failed',
      'target-resolution-failed',
    ]);
  });

  it('marks file inventory unavailable when no target resolver was captured', async () => {
    const root = tempRoot();
    writeJson(join(root, 'package.json'), { name: 'root' });
    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
    });

    expect(inventory.snapshot.packages).toHaveLength(1);
    expect(inventory.snapshot.files).toEqual([
      expect.objectContaining({
        path: 'package.json',
        roles: ['configuration'],
        targets: [],
      }),
    ]);
    expect(inventory.snapshot.coverage).toEqual({
      status: 'unavailable',
      reasonCodes: ['targets-unavailable'],
      observed: 1,
    });
  });

  it('returns a bounded unavailable snapshot for abort and an unreadable root', async () => {
    const root = tempRoot();
    writeJson(join(root, 'package.json'), { name: 'root' });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      signal: controller.signal,
    });
    expect(cancelled.snapshot.coverage.reasonCodes).toEqual(['inventory-cancelled']);

    const missing = await buildProjectInventory({
      projectRoot: join(root, 'missing'),
      configIdentity: '',
    });
    expect(missing.snapshot.coverage.reasonCodes).toEqual([
      'config-identity-invalid',
      'project-root-unavailable',
    ]);
  });

  it('rejects target symlink escapes and reports duplicate package names', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeJson(join(root, 'package.json'), {
      name: 'duplicate',
      workspaces: ['packages/*'],
    });
    writeJson(join(root, 'packages/leaf/package.json'), { name: 'duplicate' });
    const outsideFile = writeSource(outside, 'outside.ts');
    const link = join(root, 'linked.ts');
    symlinkSync(outsideFile, link);
    const targets = new FakeTargets([target('source', { languages: ['typescript'] })], {
      source: [link],
    });

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
    });

    expect(inventory.snapshot.files.map((file) => file.path)).toEqual(['package.json']);
    expect(inventory.snapshot.packages.map((pkg) => pkg.root)).toEqual(['.']);
    expect(inventory.snapshot.coverage.reasonCodes).toEqual([
      'file-outside-root-or-unreadable',
      'package-name-duplicate',
    ]);
  });

  it('retains an in-root symlink as its configured lexical file identity', async () => {
    const root = tempRoot();
    writeJson(join(root, 'package.json'), { name: 'root' });
    const targetFile = writeSource(root, 'src/real.ts');
    const linkedFile = join(root, 'src/linked.ts');
    symlinkSync(targetFile, linkedFile);
    const targets = new FakeTargets([target('source', { languages: ['typescript'] })], {
      source: [linkedFile],
    });

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
    });

    expect(inventory.fileByPath.get('src/linked.ts')).toMatchObject({
      path: 'src/linked.ts',
      targets: ['source'],
    });
    expect(inventory.fileByPath.has('src/real.ts')).toBe(false);
  });
});
