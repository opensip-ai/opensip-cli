import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { preResolveAllTargets, resolveTargets } from '../resolve.js';
import { TargetRegistry } from '../target-registry.js';

import type { Target } from '@opensip-cli/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Substrate registry tests — the GENERIC surface only (register/get/byTag/has/
 * size/clear + silent-skip). The scope-matching `findByScope` is a check-domain
 * concept that stays in `@opensip-cli/fitness`, so it is NOT exercised here
 * (its tests live alongside the fitness subclass).
 */

const stub = (name: string, opts: { tags?: string[] } = {}): Target => ({
  config: {
    name,
    description: name,
    include: [`${name}/**`],
    exclude: [],
    ...(opts.tags && { tags: opts.tags }),
  },
});

describe('TargetRegistry (substrate)', () => {
  it('register adds new targets and returns this for chaining', () => {
    const reg = new TargetRegistry();
    const result = reg.register(stub('a')).register(stub('b'));
    expect(result).toBe(reg);
    expect(reg.size).toBe(2);
  });

  it('register silently skips duplicate names', () => {
    const reg = new TargetRegistry();
    reg.register(stub('a'));
    reg.register(stub('a'));
    expect(reg.size).toBe(1);
  });

  it('getByName / has lookups', () => {
    const reg = new TargetRegistry();
    const a = stub('a');
    reg.register(a);
    expect(reg.getByName('a')).toBe(a);
    expect(reg.getByName('nope')).toBeUndefined();
    expect(reg.has('a')).toBe(true);
    expect(reg.has('nope')).toBe(false);
  });

  it('getAll returns the live set, but a fresh array each call', () => {
    const reg = new TargetRegistry();
    reg.register(stub('a'));
    const snapshot = reg.getAll();
    expect(snapshot).toHaveLength(1);
    (snapshot as Target[]).pop();
    expect(reg.getAll()).toHaveLength(1); // not affected
  });

  it('getByTag filters by config.tags', () => {
    const reg = new TargetRegistry();
    reg.register(stub('a', { tags: ['fast'] }));
    reg.register(stub('b', { tags: ['slow'] }));
    reg.register(stub('c'));
    expect(reg.getByTag('fast').map((t) => t.config.name)).toEqual(['a']);
    expect(reg.getByTag('missing')).toEqual([]);
  });

  it('clear removes everything', () => {
    const reg = new TargetRegistry();
    reg.register(stub('a'));
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.getAll()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cross-path parity: resolveTargets (per-call) vs preResolveAllTargets (optimized)
// must produce identical file sets for the same (targets, root, globals).
// This is the mechanical fix for the audit finding that the two globs+filter
// implementations could drift on excludes, dotfiles, inside-root guards, etc.
// We use the real source tree under packages/targeting/src as a stable, checked-in
// set of files so the test has no tempdir or fixture-copy requirements.
// ---------------------------------------------------------------------------

function makeTarget(name: string, include: string[], exclude: string[] = []): Target {
  return {
    config: {
      name,
      description: name,
      include,
      exclude,
    },
  };
}

describe('target resolution path parity (resolveTargets vs preResolveAllTargets)', () => {
  const rootDir = join(__dirname, '..'); // packages/targeting/src — stable files exist

  it('produces identical results for identical single-target config (no excludes)', () => {
    const reg = new TargetRegistry();
    reg.register(makeTarget('src', ['*.ts']));
    const globals: string[] = [];

    const pre = preResolveAllTargets(reg, globals, rootDir);
    const direct = resolveTargets(reg.getAll(), rootDir, globals);

    const preForT = pre.get('src') ?? [];
    // direct returns the flat union for the targets passed; for single it must match
    expect(preForT.sort()).toEqual(direct.sort());
  });

  it('produces identical results when a target has its own excludes + project globals', () => {
    const reg = new TargetRegistry();
    // Target that deliberately excludes test files; also a global exclude for node_modules (though none here)
    reg.register(makeTarget('all-ts', ['**/*.ts'], ['**/__tests__/**']));
    const globals = ['**/node_modules/**'];

    const pre = preResolveAllTargets(reg, globals, rootDir);
    const directForAll = resolveTargets([reg.getByName('all-ts')!], rootDir, globals);

    expect((pre.get('all-ts') ?? []).sort()).toEqual(directForAll.sort());
  });

  it('produces identical results for two targets sharing a pattern but with different per-target excludes', () => {
    const reg = new TargetRegistry();
    reg.register(makeTarget('no-tests', ['**/*.ts'], ['**/__tests__/**']));
    reg.register(makeTarget('only-tests', ['**/*.ts'], ['!**/__tests__/**'])); // inverted intent via exclude of non-tests
    // Note: the second will be almost empty because its exclude removes the non-test files.
    const globals: string[] = [];

    const pre = preResolveAllTargets(reg, globals, rootDir);
    const directNoTests = resolveTargets([reg.getByName('no-tests')!], rootDir, globals);
    const directOnlyTests = resolveTargets([reg.getByName('only-tests')!], rootDir, globals);

    expect((pre.get('no-tests') ?? []).sort()).toEqual(directNoTests.sort());
    expect((pre.get('only-tests') ?? []).sort()).toEqual(directOnlyTests.sort());
  });
});
