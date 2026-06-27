import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TargetRegistry } from '../../targets/target-registry.js';
import { buildScopeBasedFileMap } from '../scope-resolver.js';

import type { Target, TargetsConfig } from '../../targets/types.js';
import type { CheckScope } from '../check-config.js';

/**
 * ADR-0037 enforcement-reason guard (2): fitness per-check file-set resolution
 * is BYTE-IDENTICAL through the Phase 2 substrate migration. A fixed corpus of
 * checks × targets is resolved by the live `buildScopeBasedFileMap` (which now
 * globs via `@opensip-cli/targeting`) and asserted against a checked-in golden.
 *
 * The corpus exercises every resolution path:
 *  - per-target `exclude`            (the test-file glob drops src test files from ts-src)
 *  - project `globalExcludes`        (the generated-dir glob drops files everywhere)
 *  - multi-target union              (multi-check → ts-src ∪ rs-src)
 *  - checkOverrides precedence       (tier 1: override-check → docs)
 *  - findByScope match               (tier 2: ts-check, multi-check)
 *  - unscoped → not-in-map           (tier 3: unscoped-check absent)
 *
 * The golden was eyeballed for correctness; equality with the pre-migration
 * output is further backed by the unchanged scope-resolver.test.ts behavior
 * anchor (Phase 2 kept all 689 fitness tests green).
 */

let testDir: string;

function fixture(rel: string): void {
  const abs = join(testDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '');
}

function makeTarget(name: string, opts: Partial<Target['config']>): Target {
  return {
    config: {
      name,
      description: name,
      include: opts.include ?? [],
      exclude: opts.exclude ?? [],
      ...(opts.languages && { languages: opts.languages }),
      ...(opts.concerns && { concerns: opts.concerns }),
    },
  };
}

/** Relativize + sort each entry so the golden is path-stable across machines. */
function relativizeMap(map: Map<string, readonly string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [slug, files] of map) {
    out[slug] = files.map((f) => f.slice(testDir.length + 1)).sort();
  }
  return out;
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-scope-golden-'));
  // ── corpus fixtures ──
  fixture('src/a.ts');
  fixture('src/b.ts');
  fixture('src/a.test.ts'); // dropped by ts-src per-target exclude
  fixture('src/generated/g.ts'); // dropped by globalExcludes
  fixture('rust/lib.rs');
  fixture('rust/generated/g.rs'); // dropped by globalExcludes
  fixture('docs/readme.md');
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('scope-resolver golden (byte-identical through the substrate migration)', () => {
  it('resolves the fixed corpus to the golden file sets', () => {
    const registry = new TargetRegistry();
    registry.register(
      makeTarget('ts-src', {
        include: ['src/**/*.ts'],
        exclude: ['**/*.test.ts'],
        languages: ['typescript'],
        concerns: ['backend'],
      }),
    );
    registry.register(
      makeTarget('rs-src', {
        include: ['rust/**/*.rs'],
        languages: ['rust'],
        concerns: ['backend'],
      }),
    );
    registry.register(
      makeTarget('docs', {
        include: ['docs/**/*.md'],
        languages: ['markdown'],
        concerns: ['documentation'],
      }),
    );

    const config: TargetsConfig = {
      globalExcludes: ['**/generated/**'],
      checkOverrides: { 'override-check': 'docs' },
    };

    const checks: { slug: string; scope?: CheckScope }[] = [
      {
        slug: 'ts-check',
        scope: { languages: ['typescript'], concerns: ['backend'] },
      },
      {
        slug: 'multi-check',
        scope: { languages: ['typescript', 'rust'], concerns: ['backend'] },
      },
      { slug: 'override-check' }, // tier 1 via checkOverrides
      { slug: 'unscoped-check' }, // tier 3 → absent from the map
    ];

    const result = relativizeMap(buildScopeBasedFileMap(checks, registry, config, testDir));

    const golden: Record<string, string[]> = {
      'ts-check': ['src/a.ts', 'src/b.ts'],
      'multi-check': ['rust/lib.rs', 'src/a.ts', 'src/b.ts'],
      'override-check': ['docs/readme.md'],
      // unscoped-check intentionally ABSENT (tier 3 → fileCache fallback)
    };

    expect(result).toEqual(golden);
    expect(result['unscoped-check']).toBeUndefined();
  });
});
