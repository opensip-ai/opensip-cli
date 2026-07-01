import { describe, expect, it } from 'vitest';

import { CheckRegistry } from '../../../framework/registry.js';
import { resolveChecks } from '../../check-resolution.js';

import { FIXTURE_NAMESPACE as PACK_A, FIXTURE_SLUG as SLUG_A } from './pack-a/checks/no-eval.js';
import { FIXTURE_NAMESPACE as PACK_B } from './pack-b/checks/no-eval.js';

import type { Check } from '../../../framework/check-types.js';
import type { CheckSelector } from '../../types.js';

function makeCheck(slug: string, id: string): Check {
  return {
    config: {
      id,
      slug,
      tags: ['security'],
      description: `Check: ${slug}`,
      analysisMode: 'analyze',
      scope: { include: [], exclude: [], description: '' },
      itemType: 'files',
      // eslint-disable-next-line @typescript-eslint/require-await -- mock
      execute: async () => ({ findings: [], passed: true }),
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    run: async () => ({ findings: [], passed: true }),
    getScope: () => ({ include: [], exclude: [], description: '' }),
    getMatcher: () => ({ matches: () => true }),
  } as unknown as Check;
}

function createCollisionRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  registry.register(makeCheck(SLUG_A, 'pack-a-eval'), PACK_A);
  registry.register(makeCheck(SLUG_A, 'pack-b-eval'), PACK_B);
  return registry;
}

describe('slug-collision fixture', () => {
  it('skips ambiguous bare-slug recipe references (fail-closed)', () => {
    const registry = createCollisionRegistry();
    const selector: CheckSelector = { type: 'explicit', checkIds: [SLUG_A] };
    expect(resolveChecks(selector, registry)).toEqual([]);
  });

  it('resolves namespaced selectors deterministically', () => {
    const registry = createCollisionRegistry();
    const selector: CheckSelector = {
      type: 'explicit',
      checkIds: [`${PACK_A}:${SLUG_A}`, `${PACK_B}:${SLUG_A}`],
    };
    expect(resolveChecks(selector, registry)).toEqual([`${PACK_A}:${SLUG_A}`, `${PACK_B}:${SLUG_A}`]);
  });
});