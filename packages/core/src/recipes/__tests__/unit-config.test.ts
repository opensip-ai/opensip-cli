/**
 * unit-config — scope-bound per-unit recipe config accessors. The lookup is
 * bound to `currentScope()`, so reads outside any scope return `{}` and reads
 * inside a scope return the slice stored by `setCurrentRecipeUnitConfig`.
 */

import { describe, it, expect } from 'vitest';

import { LanguageRegistry } from '../../languages/registry.js';
import { RunScope, runWithScopeSync } from '../../lib/run-scope.js';
import { ToolRegistry } from '../../tools/registry.js';
import {
  getUnitConfig,
  setCurrentRecipeUnitConfig,
  clearCurrentRecipeUnitConfig,
} from '../unit-config.js';

/** Core-internal stand-ins for the retired `test-utils/with-scope` sugar
 *  (ADR-0040 — see verdict-policy.test.ts for the cycle rationale). */
const makeTestScope = (): RunScope =>
  new RunScope({ languages: new LanguageRegistry(), tools: new ToolRegistry() });
const withScopeSync = runWithScopeSync;

interface MyUnitConfig extends Record<string, unknown> {
  readonly threshold: number;
}

describe('getUnitConfig', () => {
  it('returns an empty object when called outside any scope', () => {
    expect(getUnitConfig('any-slug')).toEqual({});
  });

  it('returns an empty object for a scope with no config set', () => {
    const scope = makeTestScope();
    const result = withScopeSync(scope, () => getUnitConfig('missing'));
    expect(result).toEqual({});
  });

  it('returns the stored slice for a matching slug', () => {
    const scope = makeTestScope();
    setCurrentRecipeUnitConfig(scope, { 'my-unit': { threshold: 42 } });
    const result = withScopeSync(scope, () => getUnitConfig<MyUnitConfig>('my-unit'));
    expect(result.threshold).toBe(42);
  });

  it('returns an empty object for a slug absent from a populated config', () => {
    const scope = makeTestScope();
    setCurrentRecipeUnitConfig(scope, { 'other-unit': { threshold: 1 } });
    const result = withScopeSync(scope, () => getUnitConfig('my-unit'));
    expect(result).toEqual({});
  });
});

describe('setCurrentRecipeUnitConfig / clearCurrentRecipeUnitConfig', () => {
  it('treats an undefined config as an empty map', () => {
    const scope = makeTestScope();
    setCurrentRecipeUnitConfig(scope, undefined);
    const result = withScopeSync(scope, () => getUnitConfig('my-unit'));
    expect(result).toEqual({});
  });

  it('clear() removes a previously-set slice', () => {
    const scope = makeTestScope();
    setCurrentRecipeUnitConfig(scope, { 'my-unit': { threshold: 7 } });
    expect(withScopeSync(scope, () => getUnitConfig<MyUnitConfig>('my-unit')).threshold).toBe(7);

    clearCurrentRecipeUnitConfig(scope);
    expect(withScopeSync(scope, () => getUnitConfig('my-unit'))).toEqual({});
  });
});
