/**
 * @fileoverview Rule-ID mapping — engine slug → OpenSIP-convention rule ID.
 *
 * The engine's `Rule.slug` follows the pattern `graph:<rule-slug>` (e.g.
 * `graph:orphan-subtree`) per `engine/src/types.ts`. OpenSIP's rule-ID
 * convention is `<package>.<rule-family>.<rule-id>` — a three-segment
 * dot-separated form that lets the reconciler classify findings by family
 * (dead-code vs duplication vs safety, etc.) without parsing message text.
 *
 * For graph-emitted findings, the first segment is always `graph` (the
 * source package). The second segment is the rule family the engine rule
 * belongs to (`dead-code`, `duplication`, `safety`). The third segment
 * is the specific rule.
 *
 * The mapping is a frozen constant — adding a new rule to the engine
 * requires updating this table explicitly. An unknown slug throws a typed
 * error so a missing mapping fails loudly at SARIF emission rather than
 * silently producing a wrong rule ID downstream.
 *
 * Co-located with the SARIF emitter (Task 2.2) so the conversion is
 * testable in isolation. Phase 2 Task 2.1 per DEC-498.
 */

import { ValidationError } from '@opensip-cli/core';

/**
 * Mapping from engine `Rule.slug` to OpenSIP-convention rule ID.
 *
 * Every entry in `engine/src/rules/registry.ts`'s `BUILT_IN_RULES` MUST
 * have an entry here. Tests in `__tests__/render/rule-id-mapping.test.ts`
 * enforce coverage by iterating `currentRules()`.
 */
export const RULE_ID_MAPPING: Readonly<Record<string, string>> = Object.freeze({
  'graph:orphan-subtree': 'graph.dead-code.orphan-subtree',
  'graph:duplicated-function-body': 'graph.duplication.duplicated-function-body',
  'graph:near-duplicate-function-body': 'graph.duplication.near-duplicate-function-body',
  'graph:no-side-effect-path': 'graph.dead-code.no-side-effect-path',
  'graph:always-throws-branch': 'graph.safety.always-throws-branch',
  'graph:test-only-reachable': 'graph.dead-code.test-only-reachable',
  // Plan D structural rules (new slugs → reversible naming pre-baseline).
  'graph:large-function': 'graph.complexity.large-function',
  'graph:wide-function': 'graph.complexity.wide-function',
  'graph:high-blast-untested': 'graph.coverage.high-blast-untested',
  'graph:cycle': 'graph.architecture.cycle',
  'graph:unexpected-coupling': 'graph.architecture.unexpected-coupling',
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

/**
 * Inverse of {@link RULE_ID_MAPPING}: OpenSIP rule ID → engine slug. The
 * mapping is 1:1, so the inverse is unambiguous. Used by the `--workspace`
 * parent to recover engine slugs from child envelopes (whose signals carry
 * the Option-A-mapped OpenSIP rule ID) before building the dashboard session
 * payload, whose per-rule metric columns are keyed on engine slugs.
 */
export const OPENSIP_RULE_ID_TO_ENGINE_SLUG: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(RULE_ID_MAPPING).map(([slug, ruleId]) => [ruleId, slug])),
);

/**
 * Translate an OpenSIP-convention rule ID back to its engine slug. Returns
 * the input unchanged when it is already an engine slug (or otherwise
 * unmapped) so callers can pass through signals that were never remapped.
 */
export function mapOpenSipRuleIdToEngineSlug(ruleId: string): string {
  return OPENSIP_RULE_ID_TO_ENGINE_SLUG[ruleId] ?? ruleId;
}
