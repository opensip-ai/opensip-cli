/**
 * SaaS-mode concurrent-scope smoke test.
 *
 * Phase 7 / Task 7.1 of the RunScope + Registry refactor. The cross-cutting
 * T1 finding's resolution evidence.
 *
 * RunScope is supposed to make in-process concurrency safe. The simplest
 * demonstration is to construct two `RunScope`s against two different
 * fixture projects and call `executeFit` for both concurrently inside
 * `Promise.all`. If any module-level singleton survived the refactor, one
 * scope's state would leak into the other — the assertions below would
 * detect it.
 *
 * What this test does NOT do:
 *  - Exercise the full CLI bootstrap (that's covered by e2e tests).
 *  - Register check packs (we want minimal projects so the only state
 *    that could plausibly leak is the scope-bound state we just added).
 *
 * What it DOES prove:
 *  - `runWithScope` correctly binds a scope for the dynamic extent of
 *    its callback (AsyncLocalStorage isolation).
 *  - `currentScope()` reads the right scope from inside concurrent
 *    callbacks.
 *  - `executeFit` runs to completion against two distinct project roots
 *    in parallel without state crossover.
 *  - `parseCache` instances on each scope are independent (no shared
 *    Map state).
 *  - The pre-refactor `Symbol.for(globalThis)` recipe-config slot is
 *    gone (covered by `check-config.test.ts`'s two-copies-of-fitness
 *    test; this test re-verifies via a different code path).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LanguageRegistry,
  RunScope,
  ToolRegistry,
  currentScope,
  runWithScope,
} from '@opensip-tools/core';
import { fitnessTool } from '@opensip-tools/fitness';
import { executeFit } from '@opensip-tools/fitness/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FitOptions } from '@opensip-tools/contracts';

let projectA: string;
let projectB: string;

function writeFixture(dir: string, includeGlob: string, srcFiles: Record<string, string>): void {
  writeFileSync(
    join(dir, 'opensip-tools.config.yml'),
    `targets:
  source:
    description: smoke fixture
    languages: [typescript]
    concerns: [backend]
    include:
      - "${includeGlob}"
`,
  );
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const [name, body] of Object.entries(srcFiles)) {
    writeFileSync(join(dir, 'src', name), body);
  }
}

beforeEach(() => {
  projectA = mkdtempSync(join(tmpdir(), 'opensip-saas-a-'));
  projectB = mkdtempSync(join(tmpdir(), 'opensip-saas-b-'));

  // Project A: include all .ts files; one source file.
  writeFixture(projectA, 'src/**/*.ts', {
    'index.ts': 'export const A = "alpha";\n',
  });

  // Project B: include only foo.ts (narrower glob), two source files
  // so the glob's effect is observable.
  writeFixture(projectB, 'src/foo.ts', {
    'foo.ts': 'export const B_FOO = "bravo-foo";\n',
    'bar.ts': 'export const B_BAR = "bravo-bar";\n',
  });
});

afterEach(() => {
  rmSync(projectA, { recursive: true, force: true });
  rmSync(projectB, { recursive: true, force: true });
});

function makeArgs(cwd: string): FitOptions {
  return {
    json: false,
    list: false,
    recipes: false,
    verbose: false,
    findings: false,
    debug: false,
    quiet: true,
    open: false,
    cwd,
    exclude: [],
    gateSave: false,
    gateCompare: false,
  };
}

/**
 * Build a fresh scope per project, with its own registries and parse cache,
 * plus fitness's contributed subscope (`scope.fitness.{checks,recipes,load}`)
 * — the production wiring the CLI pre-action-hook performs. `executeFit` reads
 * the scope-owned check/recipe registries and the per-run load state, so two
 * independently-contributed scopes are exactly what proves there is no
 * cross-scope crossover.
 */
function makeScope(): RunScope {
  const scope = new RunScope({
    tools: new ToolRegistry(),
    languages: new LanguageRegistry(),
  });
  Object.assign(scope, fitnessTool.contributeScope?.() ?? {});
  return scope;
}

describe('SaaS-mode concurrent scopes', () => {
  it('two RunScopes run executeFit concurrently in one process without state crossover', async () => {
    const scopeA = makeScope();
    const scopeB = makeScope();

    // Capture the bound scope from inside each callback. If
    // AsyncLocalStorage works correctly, each callback sees only its
    // own scope even though the two run concurrently.
    let observedScopeInA: RunScope | undefined;
    let observedScopeInB: RunScope | undefined;

    const [a, b] = await Promise.all([
      runWithScope(scopeA, async () => {
        observedScopeInA = currentScope();
        return executeFit(makeArgs(projectA));
      }),
      runWithScope(scopeB, async () => {
        observedScopeInB = currentScope();
        return executeFit(makeArgs(projectB));
      }),
    ]);

    // 1. ALS isolation: each callback saw exactly its own scope.
    expect(observedScopeInA).toBe(scopeA);
    expect(observedScopeInB).toBe(scopeB);
    expect(observedScopeInA).not.toBe(observedScopeInB);

    // 2. Both executions produced an envelope (no error result).
    expect(a.result.type).not.toBe('error');
    expect(b.result.type).not.toBe('error');
    expect(a.envelope).toBeDefined();
    expect(b.envelope).toBeDefined();

    // 3. Envelopes are distinct objects (no shared output cache).
    expect(a.envelope).not.toBe(b.envelope);

    // 4. Each scope's parseCache is independent. Touching one must not
    //    surface in the other.
    scopeA.parseCache.filteredContent.set('A-only-key', { marker: 'A' });
    scopeB.parseCache.filteredContent.set('B-only-key', { marker: 'B' });
    expect(scopeA.parseCache.filteredContent.has('A-only-key')).toBe(true);
    expect(scopeA.parseCache.filteredContent.has('B-only-key')).toBe(false);
    expect(scopeB.parseCache.filteredContent.has('B-only-key')).toBe(true);
    expect(scopeB.parseCache.filteredContent.has('A-only-key')).toBe(false);

    // 5. Each scope's registries are independent instances.
    expect(scopeA.tools).not.toBe(scopeB.tools);
    expect(scopeA.languages).not.toBe(scopeB.languages);

    // 6. Outside the callbacks, currentScope() unwinds back to
    //    undefined. (No enterWith leak across Promise.all boundary.)
    expect(currentScope()).toBeUndefined();

    // Cleanup.
    scopeA.dispose();
    scopeB.dispose();
  });

  it('recipe-config slot is scope-bound, not global', async () => {
    const scopeA = makeScope();
    const scopeB = makeScope();

    // Seed the slot in A; B's slot must remain empty.
    scopeA.recipeUnitConfig.set('check-x', { from: 'A' });

    const [aSeesOwn, bSeesNothing] = await Promise.all([
      runWithScope(scopeA, () => {
        return Promise.resolve(currentScope()?.recipeUnitConfig.get('check-x'));
      }),
      runWithScope(scopeB, () => {
        return Promise.resolve(currentScope()?.recipeUnitConfig.get('check-x'));
      }),
    ]);

    expect(aSeesOwn).toEqual({ from: 'A' });
    expect(bSeesNothing).toBeUndefined();

    scopeA.dispose();
    scopeB.dispose();
  });
});
