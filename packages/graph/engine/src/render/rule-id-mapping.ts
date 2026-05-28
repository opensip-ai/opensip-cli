/**
 * @fileoverview Rule-ID mapping — engine slug → OpenSIP-convention rule ID.
 *
 * The engine's `Rule.slug` follows the pattern `graph:<rule-slug>` (e.g.
 * `graph:orphan-subtree`) per `engine/src/types.ts`. OpenSIP's rule-ID
 * convention is `<package>.<rule-family>.<rule-id>` — a three-segment
 * dot-separated form that lets the reconciler classify findings by family
 * (dead-code vs complexity vs safety, etc.) without parsing message text.
 *
 * For graph-emitted findings, the first segment is always `graph` (the
 * source package). The second segment is the rule family the engine rule
 * belongs to (`dead-code`, `complexity`, `duplication`, `safety`). The
 * third segment is the specific rule.
 *
 * The mapping is a frozen constant — adding a new rule to the engine
 * requires updating this table explicitly. An unknown slug throws a typed
 * error so a missing mapping fails loudly at SARIF emission rather than
 * silently producing a wrong rule ID downstream.
 *
 * Co-located with the SARIF emitter (Task 2.2) so the conversion is
 * testable in isolation. Phase 2 Task 2.1 per DEC-498.
 */

import { ValidationError } from '@opensip-tools/core';

/**
 * Mapping from engine `Rule.slug` to OpenSIP-convention rule ID.
 *
 * Every entry in `engine/src/rules/registry.ts`'s `BUILT_IN_RULES` MUST
 * have an entry here. Tests in `__tests__/render/rule-id-mapping.test.ts`
 * enforce coverage by iterating `currentRules()`.
 */
export const RULE_ID_MAPPING: Readonly<Record<string, string>> = Object.freeze({
  'graph:orphan-subtree': 'graph.dead-code.orphan-subtree',
  'graph:high-blast-function': 'graph.complexity.high-blast-function',
  'graph:duplicated-function-body': 'graph.duplication.duplicated-function-body',
  'graph:no-side-effect-path': 'graph.dead-code.no-side-effect-path',
  'graph:always-throws-branch': 'graph.safety.always-throws-branch',
  'graph:test-only-reachable': 'graph.dead-code.test-only-reachable',
});

/**
 * OpenSIP-convention rule ID regex. Three dot-separated segments, lowercase
 * kebab-case allowed in each segment. The SARIF emitter asserts every
 * `result.ruleId` matches this; tests verify the regex against every
 * mapping entry.
 */
export const OPENSIP_RULE_ID_REGEX = /^graph\.[a-z-]+\.[a-z-]+$/;

/**
 * Translate an engine slug to its OpenSIP-convention rule ID.
 *
 * @throws {ValidationError} when `slug` is not in `RULE_ID_MAPPING`. This
 *   is a programmer error (a rule was added to the engine registry
 *   without updating this table), not a runtime input issue — fail loudly
 *   at SARIF emission rather than emit an invalid wire format.
 */
export function mapEngineSlugToOpenSipRuleId(slug: string): string {
  const mapped = RULE_ID_MAPPING[slug];
  if (mapped === undefined) {
    throw new ValidationError(
      `No OpenSIP rule-ID mapping for engine slug "${slug}". Add an entry to RULE_ID_MAPPING in engine/src/render/rule-id-mapping.ts.`,
    );
  }
  return mapped;
}
