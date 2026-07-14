import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  collectAllTargets,
  targetFileResolution,
  type TargetResolutionContext,
} from './inventory-target-collection.js';
import { DEFAULT_INVENTORY_LIMITS } from './types.js';

import type { BoundedTarget, PendingFile } from './inventory-file-model.js';
import type {
  BoundedTargetMembershipResolver,
  BoundedTargetMembershipResolution,
  BoundedTargetMembershipResolutionOptions,
  BoundedTargetResolution,
  BoundedTargetResolutionOptions,
  BoundedTargetResolver,
  TargetView,
} from '@opensip-cli/core';

const roots: string[] = [];

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-target-collection-')));
  roots.push(root);
  return root;
}

function writeSource(root: string, relativePath: string): string {
  const file = join(root, relativePath);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, 'source');
  return file;
}

function boundedTarget(name: string, languages: readonly string[] = []): BoundedTarget {
  return {
    name,
    roles: [],
    literalConventionPaths: [],
    languages,
  };
}

function context(input: {
  readonly root: string;
  readonly resolver: BoundedTargetResolver;
  readonly pendingByPath?: Map<string, PendingFile>;
  readonly limits?: Partial<typeof DEFAULT_INVENTORY_LIMITS>;
  readonly signal?: AbortSignal;
}): TargetResolutionContext {
  return {
    resolver: input.resolver,
    projectRoot: input.root,
    input: {
      projectRoot: input.root,
      configIdentity: 'cfg',
      signal: input.signal,
    },
    limits: { ...DEFAULT_INVENTORY_LIMITS, ...input.limits },
    pendingByPath: input.pendingByPath ?? new Map(),
    reasons: new Set<string>(),
  };
}

class SingleTargetResolver implements BoundedTargetResolver {
  readonly globalExcludes: readonly string[] = [];
  constructor(
    private readonly resolve: (
      options: BoundedTargetResolutionOptions,
    ) => Promise<BoundedTargetResolution> | BoundedTargetResolution,
  ) {}

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

  async resolveTargetsBounded(
    _names: readonly string[],
    _rootDir: string,
    options: BoundedTargetResolutionOptions,
  ): Promise<BoundedTargetResolution> {
    return this.resolve(options);
  }

  applyGlobalExcludes(files: readonly string[]): readonly string[] {
    return files;
  }

  async applyGlobalExcludesBounded(
    files: readonly string[],
    _rootDir: string,
    options: BoundedTargetResolutionOptions,
  ): Promise<BoundedTargetResolution> {
    return {
      files: files.slice(0, options.maxResults),
      capped: false,
      cancelled: options.signal?.aborted === true,
    };
  }
}

class MembershipResolver extends SingleTargetResolver implements BoundedTargetMembershipResolver {
  constructor(
    private readonly membership: (
      options: BoundedTargetMembershipResolutionOptions,
    ) => Promise<BoundedTargetMembershipResolution> | BoundedTargetMembershipResolution,
  ) {
    super(async () => ({ files: [], capped: false, cancelled: false }));
  }

  async resolveTargetMembershipsBounded(
    _names: readonly string[],
    _rootDir: string,
    options: BoundedTargetMembershipResolutionOptions,
  ): Promise<BoundedTargetMembershipResolution> {
    return this.membership(options);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('targetFileResolution', () => {
  it('qualifies cancellation onto the returned reason set', () => {
    const controller = new AbortController();
    controller.abort();
    const pending = new Map<string, PendingFile>([
      [
        'src/a.ts',
        {
          absolutePath: '/tmp/a.ts',
          relativePath: 'src/a.ts',
          targets: [],
        },
      ],
    ]);

    const resolution = targetFileResolution(pending, ['prior'], true, controller.signal);
    expect(resolution.available).toBe(true);
    expect(resolution.reasons).toEqual(['inventory-cancelled', 'prior']);
    expect(resolution.pending.map((file) => file.relativePath)).toEqual(['src/a.ts']);
  });
});

describe('collectAllTargets single-target path', () => {
  it('adds membership for existing pending files and skips duplicate target names', async () => {
    const root = tempRoot();
    const absolutePath = writeSource(root, 'src/a.ts');
    const second = writeSource(root, 'src/b.ts');
    const target = boundedTarget('source', ['typescript']);
    const pendingByPath = new Map<string, PendingFile>([
      [
        'src/a.ts',
        {
          absolutePath,
          relativePath: 'src/a.ts',
          targets: [target],
        },
      ],
    ]);
    // First file already has the target (duplicate skip); second is newly admitted.
    const resolver = new SingleTargetResolver(async () => ({
      files: [absolutePath, second],
      capped: false,
      cancelled: false,
    }));
    const ctx = context({ root, resolver, pendingByPath });

    await collectAllTargets([target], ctx);

    expect(pendingByPath.get('src/a.ts')?.targets).toHaveLength(1);
    expect(pendingByPath.get('src/b.ts')?.targets.map((item) => item.name)).toEqual(['source']);
    expect([...ctx.reasons]).toEqual([]);
  });

  it('records membership caps when a pending file is already full', async () => {
    const root = tempRoot();
    const absolutePath = writeSource(root, 'src/a.ts');
    const existing = boundedTarget('alpha');
    const next = boundedTarget('beta');
    const pendingByPath = new Map<string, PendingFile>([
      [
        'src/a.ts',
        {
          absolutePath,
          relativePath: 'src/a.ts',
          targets: [existing],
        },
      ],
    ]);
    const resolver = new SingleTargetResolver(async () => ({
      files: [absolutePath],
      capped: false,
      cancelled: false,
    }));
    const ctx = context({
      root,
      resolver,
      pendingByPath,
      limits: { targetsPerFile: 1 },
    });

    await collectAllTargets([next], ctx);

    expect(pendingByPath.get('src/a.ts')?.targets.map((item) => item.name)).toEqual(['alpha']);
    expect([...ctx.reasons]).toEqual(['target-membership-cap-reached']);
  });

  it('records outside-root paths under a single-target resolution', async () => {
    const root = tempRoot();
    const outsideRoot = tempRoot();
    const outside = writeSource(outsideRoot, 'outside.ts');
    const keep = writeSource(root, 'src/keep.ts');
    const resolver = new SingleTargetResolver(async () => ({
      files: [outside, keep],
      capped: false,
      cancelled: false,
    }));
    const ctx = context({ root, resolver, limits: { files: 10 } });

    await collectAllTargets([boundedTarget('source')], ctx);

    expect([...ctx.pendingByPath.keys()]).toEqual(['src/keep.ts']);
    expect(ctx.reasons.has('file-outside-root-or-unreadable')).toBe(true);
  });

  it('stops admitting new files once the file budget is full', async () => {
    const root = tempRoot();
    const first = writeSource(root, 'src/first.ts');
    const second = writeSource(root, 'src/second.ts');
    const pendingByPath = new Map<string, PendingFile>([
      [
        'src/first.ts',
        {
          absolutePath: first,
          relativePath: 'src/first.ts',
          targets: [],
        },
      ],
    ]);
    const resolver = new SingleTargetResolver(async () => ({
      files: [second],
      capped: false,
      cancelled: false,
    }));
    const ctx = context({
      root,
      resolver,
      pendingByPath,
      limits: { files: 1 },
    });

    await collectAllTargets([boundedTarget('source')], ctx);

    expect([...ctx.pendingByPath.keys()]).toEqual(['src/first.ts']);
    expect([...ctx.reasons]).toEqual(['file-cap-reached']);
  });

  it('stops after a capped single-target resolution', async () => {
    const root = tempRoot();
    const file = writeSource(root, 'src/a.ts');
    const resolver = new SingleTargetResolver(async () => ({
      files: [file],
      capped: true,
      cancelled: false,
    }));
    const ctx = context({ root, resolver });

    await collectAllTargets([boundedTarget('source')], ctx);

    expect(ctx.pendingByPath.has('src/a.ts')).toBe(true);
    expect([...ctx.reasons]).toEqual(['file-cap-reached']);
  });

  it('observes cancellation before and during single-target membership collection', async () => {
    const root = tempRoot();
    const files = Array.from({ length: 70 }, (_, index) =>
      writeSource(root, `src/f-${String(index).padStart(2, '0')}.ts`),
    );
    let checks = 0;
    const signal = {
      get aborted() {
        checks += 1;
        return checks > 20;
      },
    } as AbortSignal;
    const resolver = new SingleTargetResolver(async () => ({
      files,
      capped: false,
      cancelled: false,
    }));
    const ctx = context({ root, resolver, signal });

    await collectAllTargets([boundedTarget('source')], ctx);

    expect(ctx.pendingByPath.size).toBeLessThan(files.length);
    expect(ctx.reasons.has('inventory-cancelled')).toBe(true);
  });
});

describe('collectAllTargets batched membership path', () => {
  it('records unreadable membership rows under the batch path', async () => {
    const root = tempRoot();
    const outsideRoot = tempRoot();
    const outside = writeSource(outsideRoot, 'outside.ts');
    const keep = writeSource(root, 'src/keep.ts');
    const resolver = new MembershipResolver(async () => ({
      memberships: [
        { filePath: outside, targetNames: ['alpha'] },
        { filePath: keep, targetNames: ['alpha'] },
      ],
      capped: false,
      membershipCapped: false,
      cancelled: false,
    }));
    const ctx = context({
      root,
      resolver,
      limits: { files: 10, targetsPerFile: 1 },
    });

    await collectAllTargets([boundedTarget('alpha'), boundedTarget('beta')], ctx);

    expect(ctx.reasons.has('file-outside-root-or-unreadable')).toBe(true);
    expect([...ctx.pendingByPath.keys()]).toEqual(['src/keep.ts']);
  });

  it('records file and membership caps from a bounded membership resolution', async () => {
    const root = tempRoot();
    const keep = writeSource(root, 'src/keep.ts');
    const extra = writeSource(root, 'src/extra.ts');
    const resolver = new MembershipResolver(async () => ({
      memberships: [
        { filePath: keep, targetNames: ['alpha'] },
        { filePath: extra, targetNames: ['beta'] },
      ],
      capped: true,
      membershipCapped: true,
      cancelled: false,
    }));
    const ctx = context({
      root,
      resolver,
      limits: { files: 2, targetsPerFile: 1 },
    });

    await collectAllTargets([boundedTarget('alpha'), boundedTarget('beta')], ctx);

    expect(ctx.reasons.has('file-cap-reached')).toBe(true);
    expect(ctx.reasons.has('target-membership-cap-reached')).toBe(true);
    expect(ctx.pendingByPath.size).toBe(2);
  });

  it('stops admitting memberships once the file budget is exhausted', async () => {
    const root = tempRoot();
    const keep = writeSource(root, 'src/keep.ts');
    const extra = writeSource(root, 'src/extra.ts');
    const pendingByPath = new Map<string, PendingFile>([
      [
        'src/keep.ts',
        {
          absolutePath: keep,
          relativePath: 'src/keep.ts',
          targets: [],
        },
      ],
    ]);
    const resolver = new MembershipResolver(async () => ({
      memberships: [{ filePath: extra, targetNames: ['alpha'] }],
      capped: false,
      membershipCapped: false,
      cancelled: false,
    }));
    const ctx = context({
      root,
      resolver,
      pendingByPath,
      limits: { files: 1, targetsPerFile: 1 },
    });

    await collectAllTargets([boundedTarget('alpha'), boundedTarget('beta')], ctx);

    expect([...ctx.pendingByPath.keys()]).toEqual(['src/keep.ts']);
    expect(ctx.reasons.has('file-cap-reached')).toBe(true);
  });

  it('returns early when membership resolution is cancelled', async () => {
    const root = tempRoot();
    const resolver = new MembershipResolver(async () => ({
      memberships: [],
      capped: false,
      membershipCapped: false,
      cancelled: true,
    }));
    const ctx = context({ root, resolver });

    await collectAllTargets([boundedTarget('alpha'), boundedTarget('beta')], ctx);

    expect([...ctx.reasons]).toEqual(['inventory-cancelled']);
    expect(ctx.pendingByPath.size).toBe(0);
  });

  it('observes cancellation while iterating batched membership rows', async () => {
    const root = tempRoot();
    const memberships = Array.from({ length: 70 }, (_, index) => ({
      filePath: writeSource(root, `src/m-${String(index).padStart(2, '0')}.ts`),
      targetNames: ['alpha'],
    }));
    let checks = 0;
    const signal = {
      get aborted() {
        checks += 1;
        return checks > 25;
      },
    } as AbortSignal;
    const resolver = new MembershipResolver(async () => ({
      memberships,
      capped: false,
      membershipCapped: false,
      cancelled: false,
    }));
    const ctx = context({ root, resolver, signal, limits: { targetsPerFile: 1 } });

    await collectAllTargets([boundedTarget('alpha'), boundedTarget('beta')], ctx);

    expect(ctx.pendingByPath.size).toBeLessThan(memberships.length);
    expect(ctx.reasons.has('inventory-cancelled')).toBe(true);
  });

  it('hits membership cap on an already-full pending row in the batch path', async () => {
    const root = tempRoot();
    const keep = writeSource(root, 'src/keep.ts');
    const pendingByPath = new Map<string, PendingFile>([
      [
        'src/keep.ts',
        {
          absolutePath: keep,
          relativePath: 'src/keep.ts',
          targets: [boundedTarget('alpha')],
        },
      ],
    ]);
    const resolver = new MembershipResolver(async () => ({
      memberships: [{ filePath: keep, targetNames: ['beta'] }],
      capped: false,
      membershipCapped: false,
      cancelled: false,
    }));
    const ctx = context({
      root,
      resolver,
      pendingByPath,
      limits: { targetsPerFile: 1 },
    });

    await collectAllTargets([boundedTarget('alpha'), boundedTarget('beta')], ctx);

    expect(pendingByPath.get('src/keep.ts')?.targets.map((item) => item.name)).toEqual(['alpha']);
    expect(ctx.reasons.has('target-membership-cap-reached')).toBe(true);
  });
});
