// @fitness-ignore-file phantom-dependency-detection -- vitest setupFile: test-only infra in @opensip-cli/test-support (private/unpublished, ADR-0040). `vitest` is correctly a devDependency; this file runs only under the test runner and never ships. The check exempts *.test.* / __tests__ / *.config.* but not setup files; broadening a shipped check would risk false-negatives for adopters, so we exempt this single file.
/**
 * @fileoverview Shared vitest setup for the fitness check packs.
 *
 * parallel-tool-invocations Phase 1 removed the module-singleton FileCache
 * fallback from `createExecutionContext`: a file-reading check resolves its
 * per-run cache from `currentScope()?.fitness?.fileCache` (or an explicit
 * `options.fileCache`) and throws `SYSTEM.FITNESS.NO_FILE_CACHE` otherwise.
 *
 * The check-pack execution tests (`all-checks-execute`, `behavior-fixtures*`,
 * etc.) drive `check.run(cwd, { targetFiles })` and prewarm the TEST-ONLY module
 * singleton `fileCache` (exported from `@opensip-cli/fitness`). This setup file
 * enters, per test, a fresh ambient `RunScope` whose `fitness.fileCache` IS that
 * prewarmed singleton — so those tests resolve the cache they prewarmed without
 * a per-call `options.fileCache`. Tests that construct + `runWithScope` their
 * OWN scope (the language-adapter content-filter cases) shadow this ambient
 * scope; those scopes use `makeFitnessTestScope` (their own fresh cache).
 *
 * Lives in `@opensip-cli/test-support` (a private dev-only package that already
 * depends on `@opensip-cli/core` + `@opensip-cli/fitness`) so the setup's
 * workspace imports resolve. Wired via `setupFiles` in each pack's
 * `vitest.config.ts`.
 */

import { enterScope, type RunScope } from '@opensip-cli/core';
import { beforeEach } from 'vitest';

import { makeFitnessTestScope } from './with-scope.js';

import { fitnessTestFileCache } from './index.js';

// A single shared ambient scope, built lazily on first use rather than fresh per
// test. `enterScope` (AsyncLocalStorage.enterWith) only rejects entering a
// DIFFERENT scope object while one is already current — constructing a fresh
// RunScope per test made every test after the first in a file hit that guard,
// because Vitest does not reliably propagate/clear an `enterWith`-bound store
// across separate `beforeEach` invocations for sibling tests (it is documented
// as safe only for a single command's pre-action path, never repeated calls
// across independent async boundaries like Vitest's per-test hooks). Re-entering
// the SAME object every time is a no-op for the guard, so it never throws. This
// is safe here because the ambient scope's only job is exposing the test-only
// prewarmed `fileCache` singleton below — already deliberately shared across
// every check-pack test, per the file-level doc comment — not per-test isolated
// state; tests needing real isolation already shadow this via their own
// `runWithScope(makeFitnessTestScope(), ...)`.
let sharedScope: RunScope | undefined;

function ambientScope(): RunScope {
  if (sharedScope !== undefined) return sharedScope;
  // Start from a full fitness subscope (checks/recipes/load + a fresh cache),
  // then point its fileCache at the test-only module singleton the check-pack
  // tests prewarm — so `currentScope()?.fitness?.fileCache` resolves the cache
  // they populated.
  const scope = makeFitnessTestScope();
  // The `fitness` slot is installed by makeFitnessTestScope; override its cache.
  Object.assign(scope.fitness ?? {}, { fileCache: fitnessTestFileCache });
  sharedScope = scope;
  return scope;
}

beforeEach(() => {
  enterScope(ambientScope());
});
