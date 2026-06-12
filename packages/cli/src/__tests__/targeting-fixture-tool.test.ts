import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildTargets } from '../bootstrap/build-targets.js';

import type { TargetResolver } from '@opensip-tools/core';

/**
 * ADR-0037 adoption proof (enforcement-reason guard 1): a NON-fitness tool
 * resolves a named target's files via the host-built `scope.targets`, with NO
 * `@opensip-tools/fitness` import. Until graph adopts, the deliverable is
 * *enabling* — this test is the evidence the substrate is consumable on its own.
 *
 * This file deliberately imports only the host `buildTargets` helper +
 * `@opensip-tools/core` types. It must never import `@opensip-tools/fitness`
 * (depcruise/ESLint layering would also reject a cli→fitness type cycle).
 */

let testDir: string;

function fixture(rel: string, content = ''): string {
  const abs = join(testDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

/** Relativize absolute results back to `rel/path` for stable assertions. */
function rel(files: readonly string[]): string[] {
  return files.map((f) => f.slice(testDir.length + 1)).sort();
}

/**
 * A stand-in "tool" — a plain closure with zero fitness coupling. It receives
 * the host scope-slot shape (a `TargetResolver`) and resolves a named target,
 * exactly as a future `audit`/`lint`/`graph` tool would off `scope.targets`.
 */
function fixtureToolResolve(targets: TargetResolver, names: string[]): readonly string[] {
  return targets.resolveTargets(names, testDir);
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-targeting-adoption-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('ADR-0037 adoption: a non-fitness tool resolves a target via scope.targets', () => {
  it('resolves a named target to its files, with globalExcludes applied', () => {
    fixture('src/server/handler.ts');
    fixture('src/server/router.ts');
    fixture('src/generated/schema.ts'); // excluded only by globalExcludes

    // The host builds scope.targets from the single validated config document
    // (Phase 1). The document namespaces (targets/globalExcludes) are exactly
    // what composeAndValidateToolConfig hands buildTargets at runtime.
    const targets = buildTargets({
      document: {
        targets: {
          backend: {
            description: 'backend server sources',
            include: ['src/**/*.ts'],
          },
        },
        globalExcludes: ['**/generated/**'],
      },
    });
    expect(targets).toBeDefined();

    const resolved = fixtureToolResolve(targets!, ['backend']);
    expect(rel(resolved)).toEqual(['src/server/handler.ts', 'src/server/router.ts']);
  });

  it('exposes the generic lookup surface (getByName/has/getByTag/globalExcludes)', () => {
    const targets = buildTargets({
      document: {
        targets: {
          backend: { description: 'b', include: ['src/**/*.ts'], tags: ['fast'] },
        },
        globalExcludes: ['**/dist/**'],
      },
    })!;

    expect(targets.has('backend')).toBe(true);
    expect(targets.has('frontend')).toBe(false);
    expect(targets.getByName('backend')?.config.description).toBe('b');
    expect(targets.getByTag('fast').map((t) => t.config.name)).toEqual(['backend']);
    expect(targets.globalExcludes).toEqual(['**/dist/**']);
  });

  it('returns undefined for a document with no targets block', () => {
    expect(buildTargets({ document: { globalExcludes: ['**/dist/**'] } })).toBeUndefined();
    expect(buildTargets({ document: {} })).toBeUndefined();
  });
});
