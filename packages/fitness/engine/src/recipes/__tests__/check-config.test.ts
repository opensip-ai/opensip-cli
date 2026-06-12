/**
 * @fileoverview Tests for the per-check recipe-config helper.
 *
 * As of Phase 6 Task 6.2, the slot moved off `Symbol.for(globalThis)`
 * onto the current `RunScope`. Both copies of `@opensip-cli/fitness`
 * (the CLI's bundled copy + the plugin pack's resolved copy) read
 * from the same `AsyncLocalStorage` instance exported from
 * `@opensip-cli/core` — so the slot identity is bound to core,
 * not to whichever fitness happens to load first.
 */

import { RunScope, runWithScopeSync } from '@opensip-cli/core';
import { describe, it, expect } from 'vitest';

import {
  getCheckConfig,
  setCurrentRecipeCheckConfig,
  clearCurrentRecipeCheckConfig,
} from '../check-config.js';

interface SampleConfig extends Record<string, unknown> {
  additionalEntries?: string[];
}

describe('getCheckConfig', () => {
  it('returns an empty object when no scope is active', () => {
    const cfg = getCheckConfig<SampleConfig>('any-slug');
    expect(cfg).toEqual({});
  });

  it('returns an empty object when the scope has no recipe config set', () => {
    const scope = new RunScope();
    runWithScopeSync(scope, () => {
      const cfg = getCheckConfig<SampleConfig>('any-slug');
      expect(cfg).toEqual({});
    });
  });

  it('returns an empty object for a slug not present in the recipe config', () => {
    const scope = new RunScope();
    runWithScopeSync(scope, () => {
      setCurrentRecipeCheckConfig(scope, {
        'other-check': { additionalEntries: ['x'] },
      });
      const cfg = getCheckConfig<SampleConfig>('missing');
      expect(cfg).toEqual({});
    });
  });

  it('returns the recipe-config slice for the matching slug', () => {
    const scope = new RunScope();
    runWithScopeSync(scope, () => {
      setCurrentRecipeCheckConfig(scope, {
        'sample-check': { additionalEntries: ['a', 'b'] },
      });
      const cfg = getCheckConfig<SampleConfig>('sample-check');
      expect(cfg.additionalEntries).toEqual(['a', 'b']);
    });
  });

  it('returns an empty object after clearCurrentRecipeCheckConfig is called', () => {
    const scope = new RunScope();
    runWithScopeSync(scope, () => {
      setCurrentRecipeCheckConfig(scope, {
        'sample-check': { additionalEntries: ['a', 'b'] },
      });
      clearCurrentRecipeCheckConfig(scope);
      const cfg = getCheckConfig<SampleConfig>('sample-check');
      expect(cfg).toEqual({});
    });
  });

  it('two-copies-of-fitness smoke test: separately-imported getCheckConfig sees the same scope-bound config', async () => {
    // Regression coverage for the cross-cutting T1 finding. The runtime
    // frequently has TWO copies of `@opensip-cli/fitness`:
    //
    //   1. The CLI's bundled copy (running the recipe service).
    //   2. The plugin pack's resolved copy (running the check, calling
    //      `getCheckConfig(slug)`).
    //
    // The previous design used `Symbol.for(globalThis)` to make both
    // copies share a slot. The current design routes through
    // `currentScope()` from `@opensip-cli/core` — both fitness copies
    // import the same `AsyncLocalStorage` instance from core, so the
    // slot identity is bound to core (one resolved copy) rather than to
    // whichever fitness happens to be loaded first.
    //
    // We can't easily load two real copies in a unit test, but we can
    // simulate the contract by dynamically importing the module via a
    // separate path and confirming the dynamic import's `getCheckConfig`
    // sees the scope set by the static import's `setCurrentRecipeCheckConfig`.
    const dynamicImport = await import('../check-config.js');
    const scope = new RunScope();
    runWithScopeSync(scope, () => {
      setCurrentRecipeCheckConfig(scope, {
        'sample-check': { additionalEntries: ['cross-copy'] },
      });
      const fromDynamic = dynamicImport.getCheckConfig<SampleConfig>('sample-check');
      expect(fromDynamic.additionalEntries).toEqual(['cross-copy']);
      // Belt-and-suspenders: the same imported handle agrees too.
      const fromStatic = getCheckConfig<SampleConfig>('sample-check');
      expect(fromStatic.additionalEntries).toEqual(['cross-copy']);
    });
  });
});
