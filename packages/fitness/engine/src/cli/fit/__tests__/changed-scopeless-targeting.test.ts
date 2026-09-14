/**
 * Regression: `fit --changed` must narrow SCOPE-LESS checks too.
 *
 * `buildScopeBasedFileMap` only emits a map entry for a check that resolved to
 * a target (a declared `scope`, a `checkOverrides` entry, or — new — the
 * configured `fitness.defaultTarget`). `restrictFileMapToChanged` can only
 * narrow keys that already exist, so a check declaring no scope (or an empty
 * `languages`/`concerns` pair — e.g. checks-universal's `file-length-limit`,
 * `no-todo-comments`, `no-unimplemented-markers`) used to get NO entry at all.
 * Its `matchFiles()` then fell back to the whole prewarm universe and the check
 * silently scanned the ENTIRE repo on a `--changed` run, while the run still
 * reported a fully-verified changed-file narrowing.
 *
 * The seeding pass closes that: every per-file check without a key is pinned to
 * the (globalExcludes-filtered) changed set before the restriction runs.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { basename, join } from 'node:path';

import {
  LanguageRegistry,
  RunScope,
  applyToolContributeScope,
  runWithScope,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fitnessTool } from '../../../tool.js';
import { executeFit } from '../../fit.js';
import { seedScopelessChangedTargets } from '../changed-targeting.js';

import type { FileAccessor } from '../../../framework/check-config.js';
import type * as CheckLoaderModule from '../check-loader.js';
import type { FitOptions } from '@opensip-cli/contracts';

/** slug → every filePath the check's `analyze` was handed this run. */
const analyzed = vi.hoisted(() => new Map<string, string[]>());

const SCOPELESS = 'scopeless-check';
const SCOPED = 'scoped-check';
const SCOPELESS_WHOLE_REPO = 'scopeless-analyze-all';

// Unit tests run without built @opensip-cli/checks-* dist artifacts — seed the
// two probe checks so executeFit reaches the recipe path (ADR-0060 fail-closed
// otherwise). One declares NO scope (the regression subject), one declares a
// scope (the control that the pre-existing narrowing already covered).
vi.mock('../check-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CheckLoaderModule>();
  const { currentCheckRegistry, currentFitnessLoadState } =
    await import('../../../framework/scope-registry.js');
  const { defineCheck } = await import('../../../framework/define-check.js');
  const record =
    (slug: string) =>
    (_content: string, filePath: string): [] => {
      const seen = analyzed.get(slug) ?? [];
      seen.push(filePath);
      analyzed.set(slug, seen);
      return [];
    };
  return {
    ...actual,
    ensureChecksLoaded: vi.fn((projectDir = '') => {
      const registry = currentCheckRegistry();
      if (registry.listEnabled().length === 0) {
        registry.register(
          defineCheck({
            id: '00000000-0000-4000-8000-0000000000a1',
            slug: 'scopeless-check',
            description: 'declares no scope at all',
            tags: ['test'],
            analyze: record('scopeless-check'),
          }),
          '@opensip-cli/test',
        );
        registry.register(
          defineCheck({
            id: '00000000-0000-4000-8000-0000000000a2',
            slug: 'scoped-check',
            description: 'declares a scope that matches the source target',
            scope: { languages: ['typescript'], concerns: ['backend'] },
            tags: ['test'],
            analyze: record('scoped-check'),
          }),
          '@opensip-cli/test',
        );
        registry.register(
          defineCheck({
            id: '00000000-0000-4000-8000-0000000000a3',
            slug: 'scopeless-analyze-all',
            description: 'a scope-less WHOLE-REPO invariant (mirrors stale-build-artifacts)',
            tags: ['test'],
            analyzeAll: (files: FileAccessor) => {
              analyzed.set('scopeless-analyze-all', [...files.paths]);
              return Promise.resolve([]);
            },
          }),
          '@opensip-cli/test',
        );
      }
      const load = currentFitnessLoadState();
      load.loadedFor = projectDir;
      load.pluginLoadErrors = [];
      load.checkPackErrors = [];
      load.loadWarnings = [];
      load.degradedDiagnostics = [];
      load.commandError = undefined;
      load.loadDegraded = undefined;
      load.outcomeFinalized = true;
    }),
  };
});

const CONFIG_YML = `targets:
  source:
    description: project source
    languages: [typescript]
    concerns: [backend]
    include:
      - "src/**/*.ts"
`;

const CONFIG_DOCUMENT = {
  targets: {
    source: {
      description: 'project source',
      languages: ['typescript'],
      concerns: ['backend'],
      include: ['src/**/*.ts'],
    },
  },
};

let projectDir: string;

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', [...args], { cwd, stdio: 'ignore' });
}

beforeEach(() => {
  analyzed.clear();
  projectDir = mkdtempSync(join(tmpdir(), 'opensip-fit-scopeless-'));
  writeFileSync(join(projectDir, 'opensip-cli.config.yml'), CONFIG_YML);
  mkdirSync(join(projectDir, 'src'));
  writeFileSync(join(projectDir, 'src', 'changed.ts'), 'export const a = 1;\n');
  writeFileSync(join(projectDir, 'src', 'untouched.ts'), 'export const b = 2;\n');
  git(projectDir, ['init']);
  git(projectDir, ['config', 'user.email', 't@example.com']);
  git(projectDir, ['config', 'user.name', 'T']);
  git(projectDir, ['add', '.']);
  git(projectDir, ['commit', '-m', 'init']);
  // Exactly one working-tree modification — the changed set for this run.
  writeFileSync(join(projectDir, 'src', 'changed.ts'), 'export const a = 11;\n');
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function makeArgs(overrides: Partial<FitOptions> = {}): FitOptions {
  return {
    json: false,
    list: false,
    recipes: false,
    verbose: false,
    debug: false,
    quiet: true,
    open: false,
    cwd: projectDir,
    exclude: [],
    gateSave: false,
    gateCompare: false,
    ...overrides,
  };
}

function withFitScope<T>(fn: () => Promise<T>): Promise<T> {
  const scope = new RunScope({ languages: new LanguageRegistry() });
  applyToolContributeScope(scope, fitnessTool);
  Object.assign(scope, { configDocument: CONFIG_DOCUMENT });
  return runWithScope(scope, fn);
}

/** File names (not full paths) the named check was handed this run. */
function seenNames(slug: string): string[] {
  return (analyzed.get(slug) ?? []).map((f) => basename(f));
}

describe('seedScopelessChangedTargets', () => {
  it('seeds the changed set for per-file checks with NO scope-map key', () => {
    const changedTargets = [path.resolve('/proj/src/a.ts')];
    const scopeMap = new Map<string, readonly string[]>([['scoped', [path.resolve('/proj/x.ts')]]]);

    const seeded = seedScopelessChangedTargets(scopeMap, {
      allCheckKeys: ['scoped', 'unscoped'],
      fullScopeKeys: new Set(),
      changedTargets,
    });

    // The absent key now has an EXPLICIT entry — without it the check falls back
    // to the whole-repo fileCache and `--changed` is silently a full scan.
    expect(seeded.get('unscoped')).toEqual(changedTargets);
    // A key that resolution DID produce is untouched here (restrictFileMapToChanged narrows it).
    expect(seeded.get('scoped')).toEqual([path.resolve('/proj/x.ts')]);
  });

  it('leaves analyzeAll (full-scope) checks unseeded so they keep the whole-repo view', () => {
    const seeded = seedScopelessChangedTargets(new Map(), {
      allCheckKeys: ['whole-repo'],
      fullScopeKeys: new Set(['whole-repo']),
      changedTargets: [path.resolve('/proj/src/a.ts')],
    });
    // Narrowing a cross-file invariant to the changed subset would make an
    // unchanged target read as absent — an absent key (whole-repo) is correct.
    expect(seeded.has('whole-repo')).toBe(false);
  });

  it('seeds an EMPTY list when nothing changed (target nothing, not everything)', () => {
    const seeded = seedScopelessChangedTargets(new Map(), {
      allCheckKeys: ['unscoped'],
      fullScopeKeys: new Set(),
      changedTargets: [],
    });
    expect(seeded.get('unscoped')).toEqual([]);
  });
});

describe('fit --changed with a scope-less check', () => {
  it('scans ONLY the changed files, not the whole repo', async () => {
    const fit = await withFitScope(() => executeFit(makeArgs({ changed: true })));

    expect(fit.result.type).not.toBe('error');
    // Control: the scoped check was already narrowed correctly.
    expect(seenNames(SCOPED)).toEqual(['changed.ts']);
    // Regression: the scope-less check used to see every prewarmed file.
    expect(seenNames(SCOPELESS)).toContain('changed.ts');
    expect(seenNames(SCOPELESS)).not.toContain('untouched.ts');
    expect(seenNames(SCOPELESS)).toEqual(['changed.ts']);
  });

  it('still gives a scope-less analyzeAll check the WHOLE repo under --changed', async () => {
    const fit = await withFitScope(() => executeFit(makeArgs({ changed: true })));

    expect(fit.result.type).not.toBe('error');
    // A cross-file / whole-repo invariant must not be narrowed — an unchanged
    // target would read as absent. `stale-build-artifacts` is the bundled
    // instance of this shape (scope-less AND analyzeAll).
    expect(seenNames(SCOPELESS_WHOLE_REPO)).toEqual(
      expect.arrayContaining(['changed.ts', 'untouched.ts']),
    );
  });

  it('a full (non-changed) run still lets a scope-less check see the whole project', async () => {
    const fit = await withFitScope(() => executeFit(makeArgs()));

    expect(fit.result.type).not.toBe('error');
    // The fileCache fallback is correct for a full run — the seeding pass must
    // not leak into it.
    expect(seenNames(SCOPELESS)).toEqual(expect.arrayContaining(['changed.ts', 'untouched.ts']));
  });
});
