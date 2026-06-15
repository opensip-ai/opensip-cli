/**
 * @fileoverview graph-signal-stamped — graph rules must stamp identity via
 *               createGraphSignal (§5.9). Project-local SELF-check.
 *
 * Relocated out of `@opensip-cli/checks-*` (placement sweep) because it encodes
 * opensip-cli local facts: it hardcodes the first-party graph-rules path
 * (`packages/graph/engine/src/rules/`), the basenames of opensip-cli' OWN graph
 * infrastructure files (`create-graph-signal.ts`, `define-rule.ts`,
 * `registry.ts`), and the release-2.13.0 §5.9 signal-identity convention
 * (`createGraphSignal` factory vs the low-level `createSignal` with a hand-typed
 * `source: 'graph'` / `ruleId:`). A consumer repo has none of those paths or
 * that internal factory, so the rule is opensip-internal, not universal. Inert
 * for adopters per opensip-cli/fit/checks/README.md.
 *
 * WHY: Release 2.13.0 moved graph-rule signal identity into a factory: a rule
 * supplies its slug + per-signal body to `createGraphSignal`, which STAMPS
 * `source: 'graph'`, `ruleId`, and the severity override. A rule that
 * hand-assembles that identity (`createSignal({ source: 'graph', ruleId:
 * 'graph:…', … })`) retypes fingerprint-relevant fields that feed SARIF
 * baselines — the drift §5.9 removes.
 *
 * This check flags, in graph RULE files, the low-level `createSignal(` call and
 * the hand-typed `source: 'graph'` / `ruleId:` identity keys.
 * `strip-strings-and-comments` keeps doc/example mentions from false-firing; the
 * factory itself (`create-graph-signal.ts`), the rule infrastructure
 * (`_`-prefixed helpers, `define-rule.ts`, `registry.ts`), and tests are exempt.
 */
import { defineCheck } from '@opensip-cli/fitness';

/** Graph rule sources — where rules build their signals. */
const GRAPH_RULES_PATH = 'packages/graph/engine/src/rules/';

/** Tests + the factory + rule infrastructure may name the identity legitimately. */
const TEST_PATH = /\.test\.tsx?$|\/__tests__\//;
const EXEMPT_BASENAMES = new Set([
  'create-graph-signal.ts', // the factory that DOES stamp source/ruleId
  'define-rule.ts', // the Rule adapter (carries the slug as metadata)
  'registry.ts', // lists the rules
]);

const RULES = [
  {
    re: /\bcreateSignal\s*\(/,
    message:
      'Graph rules must build signals via createGraphSignal (§5.9), not the low-level ' +
      'createSignal — so source/ruleId/severity identity is stamped, not retyped.',
  },
  {
    re: /\bsource:\s*['"]graph['"]/,
    message:
      "Graph rules must not hand-type `source: 'graph'` — createGraphSignal stamps it (§5.9).",
  },
  {
    re: /\bruleId:\s*/,
    message:
      'Graph rules must not hand-type `ruleId:` — createGraphSignal stamps it from the slug (§5.9).',
  },
];

/** Pure analysis. Exported for unit tests. */
export function analyzeGraphSignalStamped(content) {
  const violations = [];
  for (const [i, line] of content.split('\n').entries()) {
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        violations.push({
          message: rule.message,
          severity: 'error',
          line: i + 1,
          suggestion:
            'Replace with createGraphSignal(slug, config, { severity, category, message, … }).',
        });
      }
    }
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: 'a09a09f6-13c1-4988-9275-aec0ef3572e5',
    slug: 'graph-signal-stamped',
    description:
      'Graph rules must stamp identity via createGraphSignal, not hand-assemble source/ruleId/severity (§5.9)',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'quality'],
    fileTypes: ['ts', 'tsx'],
    contentFilter: 'strip-strings-and-comments',
    analyze: (content, filePath) => {
      if (!filePath.includes(GRAPH_RULES_PATH) || TEST_PATH.test(filePath)) return [];
      const basename = filePath.split('/').at(-1) ?? '';
      if (basename.startsWith('_') || EXEMPT_BASENAMES.has(basename)) return [];
      return analyzeGraphSignalStamped(content);
    },
  }),
];
