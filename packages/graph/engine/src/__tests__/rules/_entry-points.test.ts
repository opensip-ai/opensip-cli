/**
 * Tests for the shared entry-point inference helper.
 *
 * Coverage of the three classification reasons emitted today:
 * module-init, name-match, no-callers-exported.
 */

import { RunScope, runWithScopeSync, type TargetResolver } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { inferEntryPoints } from '../../rules/_entry-points.js';

import { makeCatalog, occ, staticCall } from './_helpers.js';

describe('inferEntryPoints', () => {
  it('classifies module-init occurrences as entry points', () => {
    const init = occ({
      bodyHash: 'mi',
      simpleName: '<module-init:a.ts>',
      kind: 'module-init',
    });
    const catalog = makeCatalog([init]);
    const eps = inferEntryPoints(catalog, buildIndexes(catalog));
    expect(eps.find((e) => e.bodyHash === 'mi')?.reason).toBe('module-init');
  });

  it('matches well-known entry-point names (main, run, start, init, register, initialize, bootstrap)', () => {
    const candidates = ['main', 'run', 'start', 'init', 'register', 'initialize', 'bootstrap'];
    const occs = candidates.map((n, i) => occ({ bodyHash: `h${i.toString()}`, simpleName: n }));
    const catalog = makeCatalog(occs);
    const eps = inferEntryPoints(catalog, buildIndexes(catalog));
    for (const o of occs) {
      expect(eps.find((e) => e.bodyHash === o.bodyHash)?.reason).toBe('name-match');
    }
  });

  it('classifies an exported, never-called function as no-callers-exported', () => {
    const ep = occ({
      bodyHash: 'e',
      simpleName: 'externalApi',
      visibility: 'exported',
    });
    const catalog = makeCatalog([ep]);
    const eps = inferEntryPoints(catalog, buildIndexes(catalog));
    expect(eps.find((e) => e.bodyHash === 'e')?.reason).toBe('no-callers-exported');
  });

  it('does not classify an exported function with callers', () => {
    const target = occ({
      bodyHash: 't',
      simpleName: 'target',
      visibility: 'exported',
    });
    const caller = occ({
      bodyHash: 'c',
      simpleName: 'caller',
      calls: [staticCall('t')],
    });
    const catalog = makeCatalog([target, caller]);
    const eps = inferEntryPoints(catalog, buildIndexes(catalog));
    expect(eps.find((e) => e.bodyHash === 't')).toBeUndefined();
  });

  it('classifies an exported function whose only caller is itself (recursion) as no-callers-exported', () => {
    // Mirrors cli-ui's renderToText: an exported recursive renderer consumed
    // only across a package boundary. Its sole in-project caller is its own
    // self-edge — that must not count as an external caller (D2), else the
    // function and its file-local helper subtree become false orphans.
    const recursive = occ({
      bodyHash: 'r',
      simpleName: 'renderRecursive',
      visibility: 'exported',
      calls: [staticCall('r')],
    });
    const catalog = makeCatalog([recursive]);
    const eps = inferEntryPoints(catalog, buildIndexes(catalog));
    expect(eps.find((e) => e.bodyHash === 'r')?.reason).toBe('no-callers-exported');
  });

  it('does not classify an exported function with a self-edge plus an external caller', () => {
    const recursive = occ({
      bodyHash: 'r2',
      simpleName: 'recursiveButUsed',
      visibility: 'exported',
      calls: [staticCall('r2')],
    });
    const caller = occ({
      bodyHash: 'u',
      simpleName: 'user',
      calls: [staticCall('r2')],
    });
    const catalog = makeCatalog([recursive, caller]);
    const eps = inferEntryPoints(catalog, buildIndexes(catalog));
    expect(eps.find((e) => e.bodyHash === 'r2')).toBeUndefined();
  });

  it('does not classify a module-local function with no callers', () => {
    const helper = occ({
      bodyHash: 'h',
      simpleName: 'helper',
      visibility: 'module-local',
    });
    const catalog = makeCatalog([helper]);
    const eps = inferEntryPoints(catalog, buildIndexes(catalog));
    expect(eps.find((e) => e.bodyHash === 'h')).toBeUndefined();
  });

  it('classifies functions in convention entrypoint files as target-convention', () => {
    const route = occ({
      bodyHash: 'route-action',
      simpleName: 'action',
      filePath: 'src/routes/users/action.ts',
      visibility: 'module-local',
    });
    const helper = occ({
      bodyHash: 'helper',
      simpleName: 'helper',
      filePath: 'src/lib/helper.ts',
      visibility: 'module-local',
    });
    const catalog = makeCatalog([route, helper]);
    const scope = new RunScope();
    Object.assign(scope, { targets: targetResolver(['src/routes/**']) });

    const eps = runWithScopeSync(scope, () => inferEntryPoints(catalog, buildIndexes(catalog)));

    expect(eps.find((e) => e.bodyHash === 'route-action')?.reason).toBe('target-convention');
    expect(eps.find((e) => e.bodyHash === 'helper')).toBeUndefined();
  });
});

function targetResolver(entrypoints: readonly string[]): TargetResolver {
  return {
    getByName: () => undefined,
    getAll: () => [
      {
        config: {
          name: 'app',
          description: 'Application',
          include: ['src/**/*.ts'],
          exclude: [],
          conventions: { entrypoints },
        },
      },
    ],
    getByTag: () => [],
    has: () => false,
    resolveTargets: () => [],
    applyGlobalExcludes: (files) => files,
    globalExcludes: [],
  };
}
