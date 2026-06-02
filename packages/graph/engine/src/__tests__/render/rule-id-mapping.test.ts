/**
 * Tests for the engine-slug → OpenSIP-rule-ID mapping (Phase 2 Task 2.1).
 *
 * Coverage invariants:
 *   1. Every rule in `currentRules()` (the built-in registry) has an
 *      entry in `RULE_ID_MAPPING`. Adding a rule without updating the
 *      mapping fails this test.
 *   2. Every mapped value matches the OpenSIP rule-ID regex
 *      (`graph.<family>.<rule>`).
 *   3. Unknown slugs throw `ValidationError`.
 */

import { describe, expect, it } from 'vitest';

import {
  mapEngineSlugToOpenSipRuleId,
  OPENSIP_RULE_ID_REGEX,
  RULE_ID_MAPPING,
} from '../../render/rule-id-mapping.js';
import { currentRules } from '../../rules/registry.js';
import { withGraphScopeSync } from '../test-utils/with-graph-scope.js';

describe('mapEngineSlugToOpenSipRuleId', () => {
  it('maps every built-in rule slug to a non-empty OpenSIP rule ID', () => {
    const rules = withGraphScopeSync(() => currentRules());
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const mapped = mapEngineSlugToOpenSipRuleId(rule.slug);
      expect(mapped, `mapping for ${rule.slug}`).toBeTruthy();
      expect(mapped, `regex for ${rule.slug}`).toMatch(OPENSIP_RULE_ID_REGEX);
    }
  });

  it('produces the documented mappings for each built-in rule', () => {
    expect(mapEngineSlugToOpenSipRuleId('graph:orphan-subtree')).toBe(
      'graph.dead-code.orphan-subtree',
    );
    expect(mapEngineSlugToOpenSipRuleId('graph:duplicated-function-body')).toBe(
      'graph.duplication.duplicated-function-body',
    );
    expect(mapEngineSlugToOpenSipRuleId('graph:no-side-effect-path')).toBe(
      'graph.dead-code.no-side-effect-path',
    );
    expect(mapEngineSlugToOpenSipRuleId('graph:always-throws-branch')).toBe(
      'graph.safety.always-throws-branch',
    );
    expect(mapEngineSlugToOpenSipRuleId('graph:test-only-reachable')).toBe(
      'graph.dead-code.test-only-reachable',
    );
  });

  it('throws ValidationError for unknown slug', () => {
    expect(() => mapEngineSlugToOpenSipRuleId('graph:fictional-rule')).toThrow(
      /No OpenSIP rule-ID mapping for engine slug "graph:fictional-rule"/,
    );
  });

  it('throws ValidationError for empty slug', () => {
    expect(() => mapEngineSlugToOpenSipRuleId('')).toThrow();
  });

  it('throws ValidationError for slug without graph: prefix', () => {
    expect(() => mapEngineSlugToOpenSipRuleId('orphan-subtree')).toThrow();
  });

  it('mapping table has no extras beyond the registered rules', () => {
    const rules = withGraphScopeSync(() => currentRules());
    const registeredSlugs = new Set(rules.map((r) => r.slug));
    for (const mappedSlug of Object.keys(RULE_ID_MAPPING)) {
      expect(
        registeredSlugs.has(mappedSlug),
        `mapping entry "${mappedSlug}" has no matching rule in currentRules() — stale entry?`,
      ).toBe(true);
    }
  });
});
