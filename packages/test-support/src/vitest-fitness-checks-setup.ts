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

import { RunScope, enterScope } from '@opensip-cli/core';
import { fileCache } from '@opensip-cli/fitness';
import { beforeEach } from 'vitest';

import { makeFitnessTestScope } from './with-scope.js';

beforeEach(() => {
  // Start from a full fitness subscope (checks/recipes/load + a fresh cache),
  // then point its fileCache at the test-only module singleton the check-pack
  // tests prewarm — so `currentScope()?.fitness?.fileCache` resolves the cache
  // they populated. `enterScope` (AsyncLocalStorage.enterWith) sets it as the
  // ambient scope for the test.
  const scope = makeFitnessTestScope();
  // The `fitness` slot is installed by makeFitnessTestScope; override its cache.
  Object.assign((scope as RunScope).fitness ?? {}, { fileCache });
  enterScope(scope);
});
