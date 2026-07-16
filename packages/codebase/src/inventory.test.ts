import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { projectInventorySnapshotSchema } from '@opensip-cli/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { byCodePoint } from './freeze.js';
import { buildProjectInventory } from './inventory.js';
import { validateBoundedTargetMembershipResolution } from './target-resolver-bounds.js';
import {
  MAX_INVENTORY_TARGETS,
  MAX_TARGET_CONVENTION_PATH_LENGTH,
  MAX_TARGET_CONVENTION_PATHS,
  MAX_TARGET_METADATA_TEXT,
  MAX_TARGET_METADATA_VALUES,
  MAX_TARGET_RESOLVED_PATH_LENGTH,
} from './types.js';

import type {
  BoundedTargetMembershipResolution,
  BoundedTargetMembershipResolutionOptions,
  BoundedTargetMembershipResolver,
  BoundedTargetResolution,
  BoundedTargetResolutionOptions,
  BoundedTargetResolver,
  TargetResolver,
  TargetView,
} from '@opensip-cli/core';

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

const HOSTILE_TARGET_METADATA_CASES: readonly {
  readonly name: string;
  readonly extra: Partial<TargetView['config']>;
}[] = [
  {
    name: 'tag count',
    extra: {
      tags: Array.from({ length: MAX_TARGET_METADATA_VALUES + 1 }, () => 'test'),
    },
  },
  {
    name: 'concern count',
    extra: {
      concerns: Array.from({ length: MAX_TARGET_METADATA_VALUES + 1 }, () => 'backend'),
    },
  },
  {
    name: 'language count',
    extra: {
      languages: Array.from({ length: MAX_TARGET_METADATA_VALUES + 1 }, () => 'typescript'),
    },
  },
  {
    name: 'tag text',
    extra: { tags: ['x'.repeat(MAX_TARGET_METADATA_TEXT + 1)] },
  },
  {
    name: 'concern text',
    extra: { concerns: ['x'.repeat(MAX_TARGET_METADATA_TEXT + 1)] },
  },
  {
    name: 'language text',
    extra: { languages: ['x'.repeat(MAX_TARGET_METADATA_TEXT + 1)] },
  },
  {
    name: 'convention count',
    extra: {
      conventions: {
        entrypoints: Array.from(
          { length: MAX_TARGET_CONVENTION_PATHS + 1 },
          (_, index) => `src/${index}.ts`,
        ),
      },
    },
  },
  {
    name: 'used-export convention count',
    extra: {
      conventions: {
        usedExports: Array.from({ length: MAX_TARGET_CONVENTION_PATHS + 1 }, (_, index) => ({
          file: `src/${index}.ts`,
          names: ['handler'],
        })),
      },
    },
  },
  {
    name: 'convention text',
    extra: {
      conventions: {
        entrypoints: [`src/${'x'.repeat(MAX_TARGET_CONVENTION_PATH_LENGTH)}.ts`],
      },
    },
  },
];

class FakeTargets implements BoundedTargetMembershipResolver {
  readonly globalExcludes = ['**/*.ignored.ts'];
  applyCalls = 0;
  readonly appliedFiles: string[][] = [];
  boundedApplyCalls = 0;
  readonly boundedAppliedFiles: string[][] = [];
  readonly boundedCalls: BoundedTargetResolutionOptions[] = [];
  readonly boundedMembershipCalls: BoundedTargetMembershipResolutionOptions[] = [];
  resolveCalls = 0;

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
    this.resolveCalls += 1;
    return names.flatMap((name) => this.files[name] ?? []);
  }

  resolveTargetsBounded(
    names: readonly string[],
    _rootDir: string,
    options: BoundedTargetResolutionOptions,
  ): Promise<BoundedTargetResolution> {
    this.boundedCalls.push(options);
    if (options.signal?.aborted === true) {
      return Promise.resolve({ files: [], capped: false, cancelled: true });
    }
    const files = [
      ...new Set(
        names
          .flatMap((name) => this.files[name] ?? [])
          .filter((file) => !file.endsWith('.ignored.ts'))
          .sort(),
      ),
    ];
    return Promise.resolve({
      files: files.slice(0, options.maxResults),
      capped: files.length > options.maxResults,
      cancelled: false,
    });
  }

  resolveTargetMembershipsBounded(
    names: readonly string[],
    _rootDir: string,
    options: BoundedTargetMembershipResolutionOptions,
  ): Promise<BoundedTargetMembershipResolution> {
    this.boundedMembershipCalls.push(options);
    if (options.signal?.aborted === true) {
      return Promise.resolve({
        memberships: [],
        capped: false,
        membershipCapped: false,
        cancelled: true,
      });
    }
    const targetNamesByFile = new Map<string, Set<string>>();
    for (const name of names) {
      for (const file of this.files[name] ?? []) {
        if (file.endsWith('.ignored.ts')) continue;
        const targetNames = targetNamesByFile.get(file) ?? new Set<string>();
        targetNames.add(name);
        targetNamesByFile.set(file, targetNames);
      }
    }
    let membershipCapped = false;
    const allMemberships = [...targetNamesByFile.entries()]
      .sort(([left], [right]) => byCodePoint(left, right))
      .map(([filePath, targetNames]) => {
        const sortedTargetNames = [...targetNames].sort(byCodePoint);
        if (sortedTargetNames.length > options.maxTargetsPerFile) membershipCapped = true;
        return {
          filePath,
          targetNames: sortedTargetNames.slice(0, options.maxTargetsPerFile),
        };
      });
    return Promise.resolve({
      memberships: allMemberships.slice(0, options.maxResults),
      capped: allMemberships.length > options.maxResults,
      membershipCapped,
      cancelled: false,
    });
  }

  applyGlobalExcludesBounded(
    files: readonly string[],
    _rootDir: string,
    options: BoundedTargetResolutionOptions,
  ): Promise<BoundedTargetResolution> {
    this.boundedApplyCalls += 1;
    this.boundedAppliedFiles.push([...files]);
    if (options.signal?.aborted === true) {
      return Promise.resolve({ files: [], capped: false, cancelled: true });
    }
    const retained = files.filter((file) => !file.endsWith('.ignored.ts')).sort();
    return Promise.resolve({
      files: retained.slice(0, options.maxResults),
      capped: retained.length > options.maxResults,
      cancelled: false,
    });
  }

  applyGlobalExcludes(files: readonly string[]): readonly string[] {
    this.applyCalls += 1;
    this.appliedFiles.push([...files]);
    return files.filter((file) => !file.endsWith('.ignored.ts'));
  }
}

function baseOnlyResolver(targets: FakeTargets): TargetResolver {
  return {
    getByName: (name) => targets.getByName(name),
    getAll: () => targets.getAll(),
    getByTag: (tag) => targets.getByTag(tag),
    has: (name) => targets.has(name),
    resolveTargets: (names) => targets.resolveTargets(names),
    applyGlobalExcludes: (files) => targets.applyGlobalExcludes(files),
    globalExcludes: targets.globalExcludes,
  };
}

function boundedWithoutMembershipResolver(targets: FakeTargets): BoundedTargetResolver {
  return {
    ...baseOnlyResolver(targets),
    resolveTargetsBounded: (names, rootDir, options) =>
      targets.resolveTargetsBounded(names, rootDir, options),
    applyGlobalExcludesBounded: (files, rootDir, options) =>
      targets.applyGlobalExcludesBounded(files, rootDir, options),
  };
}

class ThrowingTargets extends FakeTargets {
  override resolveTargetsBounded(): Promise<BoundedTargetResolution> {
    return Promise.reject(new Error('fixture resolution failure'));
  }
}

class CancellingTargets extends FakeTargets {
  override resolveTargetsBounded(
    _names: readonly string[],
    _rootDir: string,
    options: BoundedTargetResolutionOptions,
  ): Promise<BoundedTargetResolution> {
    this.boundedCalls.push(options);
    return Promise.resolve({ files: [], capped: false, cancelled: true });
  }
}

class CappedCancellingTargets extends CancellingTargets {
  override resolveTargetsBounded(
    _names: readonly string[],
    _rootDir: string,
    options: BoundedTargetResolutionOptions,
  ): Promise<BoundedTargetResolution> {
    this.boundedCalls.push(options);
    return Promise.resolve({ files: [], capped: true, cancelled: true });
  }
}

class RuntimeResolutionTargets extends FakeTargets {
  constructor(
    definitions: readonly TargetView[],
    files: Readonly<Record<string, readonly string[]>>,
    private readonly runtimeResult: (options: BoundedTargetResolutionOptions) => unknown,
  ) {
    super(definitions, files);
  }

  override async resolveTargetsBounded(
    _names: readonly string[],
    _rootDir: string,
    options: BoundedTargetResolutionOptions,
  ): Promise<BoundedTargetResolution> {
    this.boundedCalls.push(options);
    return (await this.runtimeResult(options)) as BoundedTargetResolution;
  }
}

class RuntimeMembershipTargets extends FakeTargets {
  constructor(
    definitions: readonly TargetView[],
    files: Readonly<Record<string, readonly string[]>>,
    private readonly runtimeResult: (options: BoundedTargetMembershipResolutionOptions) => unknown,
  ) {
    super(definitions, files);
  }

  override async resolveTargetMembershipsBounded(
    _names: readonly string[],
    _rootDir: string,
    options: BoundedTargetMembershipResolutionOptions,
  ): Promise<BoundedTargetMembershipResolution> {
    this.boundedMembershipCalls.push(options);
    return (await this.runtimeResult(options)) as BoundedTargetMembershipResolution;
  }
}

class RuntimeFilterTargets extends FakeTargets {
  constructor(
    definitions: readonly TargetView[],
    files: Readonly<Record<string, readonly string[]>>,
    private readonly runtimeFilter: (
      candidates: readonly string[],
      options: BoundedTargetResolutionOptions,
    ) => unknown,
  ) {
    super(definitions, files);
  }

  override async applyGlobalExcludesBounded(
    files: readonly string[],
    _rootDir: string,
    options: BoundedTargetResolutionOptions,
  ): Promise<BoundedTargetResolution> {
    this.boundedApplyCalls += 1;
    this.boundedAppliedFiles.push([...files]);
    return (await this.runtimeFilter(files, options)) as BoundedTargetResolution;
  }
}

class ThrowingExcludesTargets extends FakeTargets {
  override applyGlobalExcludesBounded(files: readonly string[]): Promise<BoundedTargetResolution> {
    if (files.length === 0) {
      return Promise.resolve({ files: [], capped: false, cancelled: false });
    }
    return Promise.reject(new Error('fixture exclude failure'));
  }
}

class ManifestExcludingTargets extends FakeTargets {
  override applyGlobalExcludesBounded(
    files: readonly string[],
    _rootDir: string,
    options: BoundedTargetResolutionOptions,
  ): Promise<BoundedTargetResolution> {
    this.boundedApplyCalls += 1;
    this.boundedAppliedFiles.push([...files]);
    const retained = files.filter(
      (file) => !file.replaceAll('\\', '/').includes('/packages/excluded/'),
    );
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

describe('buildProjectInventory', () => {
  it('never consumes overridable iterators past bounded membership array lengths', () => {
    const memberships: { readonly filePath: string; readonly targetNames: readonly string[] }[] =
      [];
    Object.defineProperty(memberships, Symbol.iterator, {
      value: function* hostileMembershipIterator() {
        yield { filePath: '/injected/a.ts', targetNames: ['alpha'] };
        yield { filePath: '/injected/b.ts', targetNames: ['beta'] };
      },
    });

    expect(
      validateBoundedTargetMembershipResolution(
        {
          memberships,
          capped: false,
          membershipCapped: false,
          cancelled: false,
        },
        1,
        1,
        new Set(['alpha', 'beta']),
      ),
    ).toEqual({
      memberships: [],
      capped: false,
      membershipCapped: false,
      cancelled: false,
    });
  });

  it('never consumes overridable target metadata iterators past their numeric lengths', async () => {
    const root = tempRoot();
    const file = writeSource(root, 'src/a.ts');
    const tags: string[] = [];
    const entrypoints: string[] = [];
    Object.defineProperty(tags, Symbol.iterator, {
      value: function* hostileTagIterator() {
        yield 'test';
      },
    });
    Object.defineProperty(entrypoints, Symbol.iterator, {
      value: function* hostileConventionIterator() {
        yield 'src/a.ts';
      },
    });
    const targets = new FakeTargets(
      [
        target('source', {
          tags,
          languages: ['typescript'],
          conventions: { entrypoints },
        }),
      ],
      { source: [file] },
    );

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
    });

    const fact = inventory.fileByPath.get('src/a.ts');
    expect(fact).toMatchObject({
      roles: ['production'],
      provenance: expect.arrayContaining([{ source: 'target', detail: 'target:source' }]),
    });
    expect(fact?.provenance.some((entry) => entry.source === 'convention')).toBe(false);
  });

  it('snapshots each host-owned target config exactly once', async () => {
    const root = tempRoot();
    const file = writeSource(root, 'src/a.ts');
    const config = target('source', { languages: ['typescript'] }).config;
    let reads = 0;
    const targetView = Object.defineProperty({}, 'config', {
      enumerable: true,
      get: () => {
        reads += 1;
        if (reads > 1) throw new Error('target config was read twice');
        return config;
      },
    }) as TargetView;
    const targets = new FakeTargets([targetView], { source: [file] });

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
    });

    expect(reads).toBe(1);
    expect(inventory.snapshot.files.map((candidate) => candidate.path)).toEqual(['src/a.ts']);
    expect(inventory.snapshot.coverage.reasonCodes).toEqual([]);
  });

  it('reads each used-export convention path once before retaining its bounded copy', async () => {
    const root = tempRoot();
    const file = writeSource(root, 'src/a.ts');
    let reads = 0;
    const usedExport = Object.defineProperty({ file: 'src/a.ts', names: ['loader'] }, 'file', {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1
          ? 'src/a.ts'
          : `src/${'x'.repeat(MAX_TARGET_CONVENTION_PATH_LENGTH + 1)}.ts`;
      },
    });
    const targets = new FakeTargets(
      [
        target('source', {
          languages: ['typescript'],
          conventions: { usedExports: [usedExport] },
        }),
      ],
      { source: [file] },
    );

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
    });

    expect(reads).toBe(1);
    expect(inventory.snapshot.coverage.reasonCodes).toEqual([]);
    expect(
      inventory.fileByPath
        .get('src/a.ts')
        ?.provenance.some((entry) => entry.source === 'convention'),
    ).toBe(true);
  });

  it('rejects hostile membership lengths without numeric coercion', () => {
    let coercions = 0;
    const hostileLength = {
      valueOf: () => {
        coercions += 1;
        return coercions === 1 ? 0 : 1000;
      },
    };
    const memberships = new Proxy([], {
      get: (values, property, receiver) =>
        property === 'length' ? hostileLength : Reflect.get(values, property, receiver),
    });

    expect(
      validateBoundedTargetMembershipResolution(
        {
          memberships,
          capped: false,
          membershipCapped: false,
          cancelled: false,
        },
        1,
        1,
        new Set(['alpha']),
      ),
    ).toBeUndefined();
    expect(coercions).toBe(0);
  });

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
    expect(targets.applyCalls).toBe(0);
    expect(targets.boundedApplyCalls).toBeGreaterThan(0);
    expect(targets.resolveCalls).toBe(0);
    expect(
      targets.boundedAppliedFiles.some((files) =>
        files.some((file) => file.endsWith('pnpm-lock.yaml')),
      ),
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
    expect(targets.boundedMembershipCalls).toHaveLength(1);
    expect(targets.boundedMembershipCalls[0]).toMatchObject({
      maxResults: 1,
      maxTargetsPerFile: 1,
    });
    expect(targets.boundedCalls).toHaveLength(0);
    expect(targets.resolveCalls).toBe(0);
  });

  it('resolves many targets through one shared bounded membership walk', async () => {
    const root = tempRoot();
    const definitions = Array.from({ length: 10 }, (_, index) => target(`target-${index}`));
    const files = Object.fromEntries(
      definitions.map((definition, index) => [
        definition.config.name,
        [writeSource(root, `src/${String(index).padStart(2, '0')}.ts`)],
      ]),
    );
    const targets = new FakeTargets(definitions, files);

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
    });

    expect(inventory.snapshot.files).toHaveLength(10);
    expect(targets.boundedMembershipCalls).toHaveLength(1);
    expect(targets.boundedCalls).toHaveLength(0);
    expect(targets.resolveCalls).toBe(0);
  });

  it('propagates cancellation to the bounded seam without materializing target results', async () => {
    const root = tempRoot();
    const file = writeSource(root, 'src/a.ts');
    const controller = new AbortController();
    const targets = new CancellingTargets([target('source', { languages: ['typescript'] })], {
      source: [file],
    });

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
      signal: controller.signal,
      limits: { files: 7 },
    });

    expect(targets.boundedCalls).toHaveLength(1);
    expect(targets.boundedCalls[0]).toEqual({
      maxResults: 7,
      signal: controller.signal,
    });
    expect(targets.resolveCalls).toBe(0);
    expect(controller.signal.aborted).toBe(false);
    expect(inventory.snapshot.files).toEqual([]);
    expect(inventory.snapshot.coverage.reasonCodes).toContain('inventory-cancelled');
  });

  it('retains independent cap and cancellation trust reasons from bounded resolution', async () => {
    const root = tempRoot();
    const targets = new CappedCancellingTargets([target('source')], {
      source: [],
    });

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
      limits: { files: 1 },
    });

    expect(inventory.snapshot.coverage).toMatchObject({
      status: 'partial',
      reasonCodes: ['file-cap-reached', 'inventory-cancelled'],
    });
    expect(targets.boundedCalls).toHaveLength(1);
    expect(targets.resolveCalls).toBe(0);
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
    expect(inventory.snapshot.coverage).toMatchObject({
      status: 'partial',
      observed: 1,
    });
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

  it('classifies inventory files from bounded target role projections', async () => {
    const root = tempRoot();
    const main = writeSource(root, 'src/main.ts');
    const other = writeSource(root, 'src/other.ts');
    const targets = new FakeTargets(
      [
        target('runtime', {
          conventions: { entrypoints: ['src/main.ts', 'src/*.ts'] },
        }),
      ],
      { runtime: [main, other] },
    );

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
    });

    expect(inventory.fileByPath.get('src/main.ts')).toMatchObject({
      roles: ['production'],
      provenance: expect.arrayContaining([
        { source: 'convention', detail: 'target-convention:runtime' },
      ]),
    });
    expect(inventory.fileByPath.get('src/other.ts')).toMatchObject({
      roles: ['unknown'],
    });
  });

  it('omits unsafe target names and language memberships as qualified partial evidence', async () => {
    const root = tempRoot();
    const file = writeSource(root, 'src/a.ts');
    const targets = new FakeTargets(
      [
        target('x'.repeat(129), { languages: ['typescript'] }),
        target('safe', { languages: ['typescript', `bad\nlanguage`] }),
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
    writeJson(join(root, 'package.json'), {
      name: 'root',
      workspaces: ['packages/*'],
    });
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
    writeJson(join(root, 'package.json'), {
      name: 'root',
      workspaces: ['packages/*'],
    });
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
    writeJson(join(root, 'package.json'), {
      name: 'root',
      workspaces: ['packages/*'],
    });
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
    writeJson(join(root, 'package.json'), {
      name: 'root',
      workspaces: ['packages/*'],
    });
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

  it('uses pnpm workspace declarations and skips discovery when root consumes the budget', async () => {
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
    expect(inventory.snapshot.coverage.reasonCodes).not.toContain('package-discovery-cap-reached');
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

  it('retains authoritative cancellation when target resolution also rejects', async () => {
    const root = tempRoot();
    const controller = new AbortController();
    const targets = new RuntimeResolutionTargets([target('source')], {}, () => {
      controller.abort();
      return Promise.reject(new Error('fixture resolution failure after abort'));
    });

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
      signal: controller.signal,
    });

    expect(controller.signal.aborted).toBe(true);
    expect(inventory.snapshot.files).toEqual([]);
    expect(inventory.snapshot.coverage.reasonCodes).toEqual([
      'inventory-cancelled',
      'target-resolution-failed',
    ]);
  });

  it('retains cancellation when target enumeration aborts before throwing', async () => {
    const root = tempRoot();
    const controller = new AbortController();
    const targets = new FakeTargets([target('source')], {});
    Object.defineProperty(targets, 'getAll', {
      value: () => {
        controller.abort();
        throw new Error('hostile target enumeration');
      },
    });

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
      signal: controller.signal,
    });

    expect(inventory.snapshot.coverage).toEqual({
      status: 'unavailable',
      reasonCodes: ['inventory-cancelled', 'target-metadata-invalid'],
      observed: 0,
    });
  });

  it('does not enter shared membership resolution after metadata projection cancels', async () => {
    const root = tempRoot();
    const controller = new AbortController();
    const cancellingConfig = target('beta').config;
    const cancellingTarget = Object.defineProperty({}, 'config', {
      enumerable: true,
      get: () => {
        controller.abort();
        return cancellingConfig;
      },
    }) as TargetView;
    const targets = new FakeTargets([target('alpha'), cancellingTarget], {});

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
      signal: controller.signal,
    });

    expect(controller.signal.aborted).toBe(true);
    expect(targets.boundedMembershipCalls).toHaveLength(0);
    expect(inventory.snapshot.coverage.reasonCodes).toEqual(['inventory-cancelled']);
  });

  it('rechecks cancellation triggered while detecting shared membership capability', async () => {
    const root = tempRoot();
    const controller = new AbortController();
    const targets = new FakeTargets([target('alpha'), target('beta')], {});
    const resolveMemberships = targets.resolveTargetMembershipsBounded.bind(targets);
    Object.defineProperty(targets, 'resolveTargetMembershipsBounded', {
      get: () => {
        controller.abort();
        return resolveMemberships;
      },
    });

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
      signal: controller.signal,
    });

    expect(controller.signal.aborted).toBe(true);
    expect(targets.boundedMembershipCalls).toHaveLength(0);
    expect(inventory.snapshot.coverage.reasonCodes).toEqual(['inventory-cancelled']);
  });

  it('retains cancellation when bounded capability detection aborts and throws', async () => {
    const root = tempRoot();
    const controller = new AbortController();
    const targets = baseOnlyResolver(new FakeTargets([target('source')], {}));
    Object.defineProperty(targets, 'resolveTargetsBounded', {
      get: () => {
        controller.abort();
        throw new Error('hostile capability getter');
      },
    });

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
      signal: controller.signal,
    });

    expect(inventory.snapshot.coverage).toEqual({
      status: 'unavailable',
      reasonCodes: ['bounded-target-resolution-unavailable', 'inventory-cancelled'],
      observed: 0,
    });
  });

  it('fails closed when a base target resolver lacks the bounded capability', async () => {
    const root = tempRoot();
    const file = writeSource(root, 'src/a.ts');
    const full = new FakeTargets([target('source')], { source: [file] });

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets: baseOnlyResolver(full),
    });

    expect(inventory.snapshot.coverage).toEqual({
      status: 'unavailable',
      reasonCodes: ['bounded-target-resolution-unavailable'],
      observed: 0,
    });
    expect(full.resolveCalls).toBe(0);
    expect(full.boundedCalls).toHaveLength(0);
  });

  it('fails closed for multiple targets when the shared membership capability is absent', async () => {
    const root = tempRoot();
    const full = new FakeTargets([target('alpha'), target('beta')], {});

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets: boundedWithoutMembershipResolver(full),
    });

    expect(inventory.snapshot.coverage).toEqual({
      status: 'unavailable',
      reasonCodes: ['bounded-target-membership-resolution-unavailable'],
      observed: 0,
    });
    expect(full.boundedCalls).toHaveLength(0);
    expect(full.boundedMembershipCalls).toHaveLength(0);
  });

  it('fails closed on malformed shared membership results', async () => {
    const cases: readonly {
      readonly name: string;
      readonly result: (file: string, root: string) => unknown;
    }[] = [
      { name: 'null result', result: () => null },
      {
        name: 'non-array memberships',
        result: () => ({
          memberships: {},
          capped: false,
          membershipCapped: false,
          cancelled: false,
        }),
      },
      {
        name: 'result beyond requested maximum',
        result: (file, root) => ({
          memberships: [
            { filePath: file, targetNames: ['alpha'] },
            { filePath: join(root, 'src/b.ts'), targetNames: ['beta'] },
          ],
          capped: true,
          membershipCapped: false,
          cancelled: false,
        }),
      },
      {
        name: 'duplicate files',
        result: (file) => ({
          memberships: [
            { filePath: file, targetNames: ['alpha'] },
            { filePath: file, targetNames: ['beta'] },
          ],
          capped: false,
          membershipCapped: false,
          cancelled: false,
        }),
      },
      {
        name: 'relative file',
        result: () => ({
          memberships: [{ filePath: 'src/a.ts', targetNames: ['alpha'] }],
          capped: false,
          membershipCapped: false,
          cancelled: false,
        }),
      },
      {
        name: 'empty target membership',
        result: (file) => ({
          memberships: [{ filePath: file, targetNames: [] }],
          capped: false,
          membershipCapped: false,
          cancelled: false,
        }),
      },
      {
        name: 'membership beyond requested maximum',
        result: (file) => ({
          memberships: [{ filePath: file, targetNames: ['alpha', 'beta'] }],
          capped: false,
          membershipCapped: true,
          cancelled: false,
        }),
      },
      {
        name: 'unknown target name',
        result: (file) => ({
          memberships: [{ filePath: file, targetNames: ['unknown'] }],
          capped: false,
          membershipCapped: false,
          cancelled: false,
        }),
      },
      {
        name: 'duplicate target name',
        result: (file) => ({
          memberships: [{ filePath: file, targetNames: ['alpha', 'alpha'] }],
          capped: false,
          membershipCapped: false,
          cancelled: false,
        }),
      },
      {
        name: 'non-plain membership row',
        result: (file) => ({
          memberships: [
            Object.assign(Object.create({ inherited: true }), {
              filePath: file,
              targetNames: ['alpha'],
            }),
          ],
          capped: false,
          membershipCapped: false,
          cancelled: false,
        }),
      },
    ];

    for (const fixtureCase of cases) {
      const root = tempRoot();
      const file = writeSource(root, 'src/a.ts');
      const targets = new RuntimeMembershipTargets([target('alpha'), target('beta')], {}, () =>
        fixtureCase.result(file, root),
      );

      const inventory = await buildProjectInventory({
        projectRoot: root,
        configIdentity: `cfg:${fixtureCase.name}`,
        targets,
        limits: { files: 1, targetsPerFile: 1 },
      });

      expect(inventory.snapshot.files, fixtureCase.name).toEqual([]);
      expect(inventory.snapshot.coverage.reasonCodes, fixtureCase.name).toContain(
        'bounded-target-membership-resolution-invalid',
      );
      expect(targets.boundedMembershipCalls, fixtureCase.name).toHaveLength(1);
    }
  });

  it('retains cancellation when shared membership resolution rejects', async () => {
    const root = tempRoot();
    const controller = new AbortController();
    const targets = new RuntimeMembershipTargets([target('alpha'), target('beta')], {}, () => {
      controller.abort();
      return Promise.reject(new Error('membership failure after abort'));
    });

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
      signal: controller.signal,
    });

    expect(inventory.snapshot.files).toEqual([]);
    expect(inventory.snapshot.coverage.reasonCodes).toEqual([
      'inventory-cancelled',
      'target-membership-resolution-failed',
    ]);
  });

  it('rechecks cancellation triggered while validating shared membership', async () => {
    const root = tempRoot();
    const file = writeSource(root, 'src/a.ts');
    const controller = new AbortController();
    const row = Object.defineProperty({ targetNames: ['alpha'] }, 'filePath', {
      enumerable: true,
      get: () => {
        controller.abort();
        return file;
      },
    });
    const targets = new RuntimeMembershipTargets([target('alpha'), target('beta')], {}, () => ({
      memberships: [row],
      capped: false,
      membershipCapped: false,
      cancelled: false,
    }));

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
      signal: controller.signal,
    });

    expect(controller.signal.aborted).toBe(true);
    expect(inventory.snapshot.files).toEqual([]);
    expect(inventory.snapshot.coverage.reasonCodes).toEqual(['inventory-cancelled']);
  });

  it('fails closed on malformed bounded target results without materializing them', async () => {
    const cases: readonly {
      readonly name: string;
      readonly result: (file: string, root: string) => unknown;
    }[] = [
      { name: 'null result', result: () => null },
      { name: 'non-plain result', result: () => new Date(0) },
      {
        name: 'non-array files',
        result: () => ({ files: {}, capped: false, cancelled: false }),
      },
      {
        name: 'non-boolean flags',
        result: () => ({ files: [], capped: 0, cancelled: false }),
      },
      {
        name: 'result beyond requested maximum',
        result: (file, root) => ({
          files: [file, join(root, 'src/b.ts'), join(root, 'src/c.ts')],
          capped: true,
          cancelled: false,
        }),
      },
      {
        name: 'duplicate paths',
        result: (file) => ({
          files: [file, file],
          capped: false,
          cancelled: false,
        }),
      },
      {
        name: 'non-string path',
        result: () => ({ files: [42], capped: false, cancelled: false }),
      },
      {
        name: 'empty path',
        result: () => ({ files: [''], capped: false, cancelled: false }),
      },
      {
        name: 'relative path',
        result: () => ({
          files: ['src/a.ts'],
          capped: false,
          cancelled: false,
        }),
      },
      {
        name: 'oversized path',
        result: (_file, root) => ({
          files: [join(root, 'x'.repeat(MAX_TARGET_RESOLVED_PATH_LENGTH))],
          capped: false,
          cancelled: false,
        }),
      },
      {
        name: 'control-character path',
        result: (_file, root) => ({
          files: [join(root, 'bad\npath')],
          capped: false,
          cancelled: false,
        }),
      },
      {
        name: 'throwing result getter',
        result: () => {
          const value = { capped: false, cancelled: false } as Record<string, unknown>;
          Object.defineProperty(value, 'files', {
            get: () => {
              throw new Error('hostile getter');
            },
          });
          return value;
        },
      },
    ];

    for (const fixtureCase of cases) {
      const root = tempRoot();
      const file = writeSource(root, 'src/a.ts');
      const targets = new RuntimeResolutionTargets([target('source')], { source: [file] }, () =>
        fixtureCase.result(file, root),
      );

      const inventory = await buildProjectInventory({
        projectRoot: root,
        configIdentity: `cfg:${fixtureCase.name}`,
        targets,
        limits: { files: 2 },
      });

      expect(inventory.snapshot.files, fixtureCase.name).toEqual([]);
      expect(inventory.snapshot.coverage.reasonCodes, fixtureCase.name).toContain(
        'bounded-target-resolution-invalid',
      );
      expect(targets.resolveCalls, fixtureCase.name).toBe(0);
      expect(targets.boundedCalls, fixtureCase.name).toHaveLength(1);
    }
  });

  it('reads each bounded result path once before retaining a defensive copy', async () => {
    const root = tempRoot();
    const file = writeSource(root, 'src/a.ts');
    let reads = 0;
    const files = new Proxy([file], {
      get: (targetFiles, property, receiver) => {
        if (property === '0') {
          reads += 1;
          if (reads > 1) throw new Error('path was read twice');
        }
        return Reflect.get(targetFiles, property, receiver) as unknown;
      },
    });
    const targets = new RuntimeResolutionTargets([target('source')], { source: [file] }, () => ({
      files,
      capped: false,
      cancelled: false,
    }));

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
    });

    expect(reads).toBe(1);
    expect(inventory.snapshot.files.map((candidate) => candidate.path)).toEqual(['src/a.ts']);
    expect(inventory.snapshot.coverage.reasonCodes).toEqual([]);
  });

  it('guards target enumeration and metadata getters inside the runtime boundary', async () => {
    const cases: readonly {
      readonly name: string;
      readonly getAll: () => unknown;
    }[] = [
      { name: 'non-array getAll', getAll: () => ({}) },
      {
        name: 'throwing array index',
        getAll: () =>
          new Proxy([target('source')], {
            get: (targets, property, receiver) => {
              if (property === '0') throw new Error('hostile target index');
              return Reflect.get(targets, property, receiver) as unknown;
            },
          }),
      },
      {
        name: 'throwing config getter',
        getAll: () => [
          Object.defineProperty({}, 'config', {
            get: () => {
              throw new Error('hostile config getter');
            },
          }),
        ],
      },
    ];

    for (const fixtureCase of cases) {
      const root = tempRoot();
      const targets = new FakeTargets([target('source')], {});
      Object.defineProperty(targets, 'getAll', { value: fixtureCase.getAll });

      const inventory = await buildProjectInventory({
        projectRoot: root,
        configIdentity: `cfg:${fixtureCase.name}`,
        targets,
      });

      expect(inventory.snapshot.coverage, fixtureCase.name).toEqual({
        status: 'unavailable',
        reasonCodes: ['target-metadata-invalid'],
        observed: 0,
      });
      expect(targets.boundedCalls, fixtureCase.name).toHaveLength(0);
    }
  });

  it('fails before discovery when the bounded global-filter preflight is malformed', async () => {
    const root = tempRoot();
    writeJson(join(root, 'package.json'), { name: 'must-not-be-observed' });
    const targets = new RuntimeFilterTargets([target('source')], {}, () => ({
      files: [],
      capped: 'no',
      cancelled: false,
    }));

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
    });

    expect(inventory.snapshot.coverage).toEqual({
      status: 'unavailable',
      reasonCodes: ['bounded-global-filter-invalid'],
      observed: 0,
    });
    expect(inventory.snapshot.packages).toEqual([]);
    expect(targets.applyCalls).toBe(0);
    expect(targets.boundedCalls).toHaveLength(0);
  });

  it('retains authoritative cancellation when the global-filter preflight is malformed', async () => {
    const root = tempRoot();
    writeJson(join(root, 'package.json'), { name: 'must-not-be-observed' });
    const controller = new AbortController();
    const targets = new RuntimeFilterTargets([target('source')], {}, () => {
      controller.abort();
      return { files: [], capped: 'no', cancelled: false };
    });

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
      signal: controller.signal,
    });

    expect(controller.signal.aborted).toBe(true);
    expect(inventory.snapshot.coverage).toEqual({
      status: 'unavailable',
      reasonCodes: ['bounded-global-filter-invalid', 'inventory-cancelled'],
      observed: 0,
    });
    expect(inventory.snapshot.packages).toEqual([]);
    expect(targets.applyCalls).toBe(0);
    expect(targets.boundedCalls).toHaveLength(0);
  });

  it('rechecks authoritative cancellation after validating a hostile bounded result', async () => {
    const root = tempRoot();
    const controller = new AbortController();
    const targets = new RuntimeFilterTargets([target('source')], {}, () => ({
      files: [],
      get capped() {
        controller.abort();
        return false;
      },
      cancelled: false,
    }));

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
      signal: controller.signal,
    });

    expect(controller.signal.aborted).toBe(true);
    expect(inventory.snapshot.coverage).toEqual({
      status: 'unavailable',
      reasonCodes: ['inventory-cancelled'],
      observed: 0,
    });
    expect(targets.boundedCalls).toHaveLength(0);
  });

  it.each(['injected', 'oversized'])(
    'rejects %s bounded structural-filter output before canonicalization',
    async (mode) => {
      const root = tempRoot();
      const marker = writeSource(root, 'pnpm-lock.yaml');
      const injected = writeSource(root, 'src/injected.ts');
      const targets = new RuntimeFilterTargets([target('source')], {}, (files) => {
        if (files.length === 0) {
          return { files: [], capped: false, cancelled: false };
        }
        return {
          files: mode === 'injected' ? [injected] : [marker, injected],
          capped: false,
          cancelled: false,
        };
      });

      const inventory = await buildProjectInventory({
        projectRoot: root,
        configIdentity: 'cfg',
        targets,
      });

      expect(inventory.snapshot.files).toEqual([]);
      expect(inventory.snapshot.coverage.reasonCodes).toContain('bounded-global-filter-invalid');
      expect(targets.applyCalls).toBe(0);
    },
  );

  it.each(HOSTILE_TARGET_METADATA_CASES)(
    'fails closed before target resolution for hostile $name metadata',
    async ({ extra }) => {
      const root = tempRoot();
      const targets = new FakeTargets([target('source', extra)], {
        source: [],
      });

      const inventory = await buildProjectInventory({
        projectRoot: root,
        configIdentity: 'cfg',
        targets,
      });

      expect(inventory.snapshot.coverage).toEqual({
        status: 'unavailable',
        reasonCodes: ['target-metadata-cap-reached'],
        observed: 0,
      });
      expect(targets.resolveCalls).toBe(0);
      expect(targets.boundedCalls).toHaveLength(0);
    },
  );

  it('fails closed before resolving when target enumeration exceeds its hard cap', async () => {
    const root = tempRoot();
    const definitions = Array.from({ length: MAX_INVENTORY_TARGETS + 1 }, (_, index) =>
      target(`target-${String(index).padStart(3, '0')}`),
    );
    const targets = new FakeTargets(definitions, {});

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
    });

    expect(inventory.snapshot.coverage).toEqual({
      status: 'unavailable',
      reasonCodes: ['target-count-cap-reached'],
      observed: 0,
    });
    expect(targets.resolveCalls).toBe(0);
    expect(targets.boundedCalls).toHaveLength(0);
  });

  it('fails closed before resolving ambiguous duplicate target names', async () => {
    const root = tempRoot();
    const targets = new FakeTargets([target('source'), target('source')], {});

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
    });

    expect(inventory.snapshot.coverage).toEqual({
      status: 'unavailable',
      reasonCodes: ['target-metadata-invalid'],
      observed: 0,
    });
    expect(targets.resolveCalls).toBe(0);
    expect(targets.boundedCalls).toHaveLength(0);
    expect(targets.boundedMembershipCalls).toHaveLength(0);
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
