import { enterScope, RunScope } from '@opensip-tools/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { fitnessTool } from '../../tool.js';

import { selectRecipe } from './recipe-selector.js';

import type { FitOptions } from '@opensip-tools/contracts';

/**
 * `selectRecipe` resolves the fit recipe with tool-scoped precedence (ADR-0022)
 * against the current scope's recipe registry, whose built-ins include
 * `default` and `backend` but NOT `opensip` (a project-private fit recipe in the
 * parent repo). These tests exercise the precedence + tolerance contract; each
 * enters a fresh RunScope carrying fitness's contributed recipe registry.
 */
const base: FitOptions = { cwd: '/tmp' } as FitOptions;

beforeEach(() => {
  const scope = new RunScope();
  Object.assign(scope, fitnessTool.contributeScope?.() ?? {});
  enterScope(scope);
});

describe('selectRecipe (ADR-0022 tool-scoped + tolerant)', () => {
  it('explicit --recipe wins and resolves a real recipe', () => {
    expect(selectRecipe({ ...base, recipe: 'backend' }, { toolRecipe: 'default' })).toEqual({
      recipeName: 'backend',
    });
  });

  it('explicit unknown --recipe hard-fails (typo protection)', () => {
    const r = selectRecipe({ ...base, recipe: 'bogus-typo' });
    expect('error' in r && r.error.message).toContain("Unknown recipe 'bogus-typo'");
  });

  it('uses fitness.recipe when no flag', () => {
    expect(selectRecipe(base, { toolRecipe: 'backend' })).toEqual({ recipeName: 'backend' });
  });

  it('a config-sourced UNKNOWN recipe tolerantly falls back to default (the leak fix)', () => {
    // A copied tool-scoped recipe name that is absent from this registry must not
    // abort — it falls back to default.
    expect(selectRecipe(base, { toolRecipe: 'also-missing' })).toEqual({ recipeName: 'default' });
  });

  it('--check / --tags force an ad-hoc recipe (recipeName undefined), ignoring config', () => {
    expect(selectRecipe({ ...base, check: 'some-check' }, { toolRecipe: 'backend' })).toEqual({
      recipeName: undefined,
    });
    expect(selectRecipe({ ...base, tags: 'quality' }, { toolRecipe: 'backend' })).toEqual({
      recipeName: undefined,
    });
  });

  it('no flag and no config → built-in default', () => {
    expect(selectRecipe(base)).toEqual({ recipeName: 'default' });
  });
});
