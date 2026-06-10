/**
 * @fileoverview The §5.3 display fold: display (icon + name) travels ON each
 * check (`check.config.icon`/`displayName`), folded from a pack's authoring map
 * via `applyCheckDisplay`; `getDisplayName`/`getIcon` resolve a slug against the
 * CURRENT scope's check registry — there is NO merged-display singleton (F3).
 */

import { RunScope, runWithScopeSync } from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

import { applyCheckDisplay } from '../../../check-utils/display.js';
import { defineCheck } from '../../../framework/define-check.js';
import { currentCheckRegistry } from '../../../framework/scope-registry.js';
import { fitnessTool } from '../../../tool.js';
import { getDisplayName, getIcon } from '../display-registry.js';

import type { Check } from '../../../framework/check-types.js';
import type { CheckDisplayEntry } from '../../../plugins/types.js';

let nextId = 0;
function stubCheck(slug: string): Check {
  nextId++;
  return defineCheck({
    id: `00000000-0000-4000-8000-${nextId.toString(16).padStart(12, '0')}`,
    slug,
    description: slug,
    tags: ['demo'],
    analyze: () => [],
  });
}

/** A RunScope carrying fitness's contributed subscope (fresh check registry). */
function fitnessScope(): RunScope {
  const scope = new RunScope();
  Object.assign(scope, fitnessTool.contributeScope?.() ?? {});
  return scope;
}

describe('applyCheckDisplay', () => {
  it('folds icon + displayName onto a check whose slug has a map entry', () => {
    const map: Record<string, CheckDisplayEntry> = { 'my-check': ['🚀', 'My Check'] };
    const [folded] = applyCheckDisplay([stubCheck('my-check')], map);
    expect(folded?.config.icon).toBe('🚀');
    expect(folded?.config.displayName).toBe('My Check');
  });

  it('passes a check with no map entry through unchanged (no display set)', () => {
    const [plain] = applyCheckDisplay([stubCheck('no-entry')], {});
    expect(plain?.config.icon).toBeUndefined();
    expect(plain?.config.displayName).toBeUndefined();
  });

  it('does not mutate the original check (returns a new object)', () => {
    const original = stubCheck('immutable');
    const [folded] = applyCheckDisplay([original], { immutable: ['🔒', 'Immutable'] });
    expect(original.config.icon).toBeUndefined();
    expect(folded).not.toBe(original);
  });
});

describe('getDisplayName / getIcon read from the scope check registry (no singleton)', () => {
  it('returns the folded display for a registered check', () => {
    runWithScopeSync(fitnessScope(), () => {
      const [folded] = applyCheckDisplay([stubCheck('rocket-check')], {
        'rocket-check': ['🚀', 'Rocket Check'],
      });
      currentCheckRegistry().register(folded);
      expect(getDisplayName('rocket-check')).toBe('Rocket Check');
      expect(getIcon('rocket-check')).toBe('🚀');
    });
  });

  it('falls back to kebab-title-case name + default icon for an unknown slug', () => {
    runWithScopeSync(fitnessScope(), () => {
      expect(getDisplayName('some-unknown-slug')).toBe('Some Unknown Slug');
      expect(getIcon('some-unknown-slug')).toBe('🔍');
    });
  });

  it('two concurrent scopes resolve display independently (F3: no shared singleton)', () => {
    const scopeA = fitnessScope();
    const scopeB = fitnessScope();
    runWithScopeSync(scopeA, () => {
      const [a] = applyCheckDisplay([stubCheck('shared-slug')], {
        'shared-slug': ['🅰️', 'From A'],
      });
      currentCheckRegistry().register(a);
    });
    runWithScopeSync(scopeB, () => {
      const [b] = applyCheckDisplay([stubCheck('shared-slug')], {
        'shared-slug': ['🅱️', 'From B'],
      });
      currentCheckRegistry().register(b);
    });
    // Each scope sees only its own registration — no cross-scope leakage.
    runWithScopeSync(scopeA, () => expect(getDisplayName('shared-slug')).toBe('From A'));
    runWithScopeSync(scopeB, () => expect(getDisplayName('shared-slug')).toBe('From B'));
  });
});
