/**
 * @fileoverview shipped-checks-must-be-generic — a check in the SHIPPED
 *               @opensip-cli/checks-* packs must apply cleanly to an arbitrary
 *               customer codebase; it must NOT encode opensip-cli local facts.
 *               Project-local SELF-check (the placement gate).
 *
 * WHY: adopters `npm install opensip-cli` and run `fit` against THEIR code. A
 * shipped check that hardcodes opensip-cli's own monorepo paths
 * (packages/graph|cli|datastore/...), cites an opensip ADR (ADR-####) or spec
 * section (§N.N), or couples to an internal engine package
 * (@opensip-cli/{graph,simulation,datastore,...}) is INERT for every adopter and
 * just clutters their `fit list`. Per opensip-cli/fit/checks/README.md, such
 * "local facts" checks belong HERE (project-local opensip-cli/fit/checks/*.mjs),
 * not in the shipped pack — "unless the rule is rewritten to apply cleanly to
 * arbitrary customer codebases."
 *
 * This gate freezes that policy in: the next opensip-internal dogfood check
 * authored straight into checks-* fails the build until it is relocated to a
 * project-local .mjs (or rewritten to be genuinely generic, or — for a true
 * exception — waived with `@fitness-ignore-file shipped-checks-must-be-generic`
 * and a justification).
 *
 * NOT flagged: the AUTHORING imports every check legitimately uses —
 * `@opensip-cli/fitness` (defineCheck/CheckViolation), `@opensip-cli/core`
 * (logger), and `@opensip-cli/lang-*` (the TS-AST helper API). These are the
 * public authoring surface, not opensip-internal facts. (raw content: the
 * signal lives in code AND comments — an ADR cited in a header is still an
 * opensip-internal fact — so nothing is stripped, and import lines are filtered
 * out explicitly below.)
 */
import { defineCheck } from '@opensip-cli/fitness';

/** Only the SHIPPED first-party check packs are governed. */
const SHIPPED_CHECK_PACK = /packages\/fitness\/checks-[a-z]+\/src\/checks\//;

/** Not a real check: tests, fixtures, barrels, display, directive sub-modules. */
const NON_CHECK =
  /\.test\.tsx?$|\/__tests__\/|\/__fixtures__\/|\/index\.ts$|\/display\/|\/_directives\//;

/** A hardcoded first-party monorepo package path — an opensip-cli local fact. */
const FIRST_PARTY_PATH =
  /packages\/(?:core|cli|fitness|graph|simulation|datastore|session-store|config|targeting|output|contracts|dashboard|cli-ui|tree-sitter|languages|lang-[a-z]+)\//;

/** An opensip ADR reference — encodes an opensip-internal architecture decision. */
const ADR_REF = /\bADR-\d{3,4}\b/;

/** An opensip spec-section citation (e.g. §5.12). */
const SECTION_REF = /§\d/;

/** An internal engine-package coupling (NOT the authoring APIs core / fitness / lang-*). */
const INTERNAL_ENGINE =
  /@opensip-cli\/(?:graph|simulation|datastore|session-store|config|targeting|output|contracts|dashboard)\b/;

/** An authoring-API import line — never itself a leak signal. */
const AUTHORING_IMPORT = /^\s*import\b.*@opensip-cli\/(?:fitness|core|lang-[a-z]+|test-support)\b/;

const SIGNALS = [
  ['a hardcoded first-party package path (packages/<pkg>/...)', FIRST_PARTY_PATH],
  ['an opensip ADR reference (ADR-NNNN)', ADR_REF],
  ['an opensip spec-section citation (§N.N)', SECTION_REF],
  ['an internal engine-package coupling (@opensip-cli/<engine>)', INTERNAL_ENGINE],
];

/** Pure analysis. Exported for direct exercise if this check grows a test harness. */
export function analyzeShippedChecksMustBeGeneric(content, filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  if (!SHIPPED_CHECK_PACK.test(normalized) || NON_CHECK.test(normalized)) return [];

  // Drop authoring-import lines so they cannot register as a signal.
  const scannable = content
    .split('\n')
    .filter((line) => !AUTHORING_IMPORT.test(line))
    .join('\n');

  const hits = SIGNALS.filter(([, re]) => re.test(scannable)).map(([label]) => label);
  if (hits.length === 0) return [];

  return [
    {
      line: 1,
      message:
        `This SHIPPED check encodes opensip-cli local facts (${hits.join('; ')}), so it is ` +
        `inert/meaningless for an adopter who installs opensip-cli and runs fit on their own ` +
        `code. Per fit/checks/README.md, opensip-internal dogfood checks must live ` +
        `project-local, not in the shipped @opensip-cli/checks-* pack.`,
      severity: 'error',
      suggestion:
        `Relocate this check to opensip-cli/fit/checks/<slug>.mjs (export const checks = ` +
        `[defineCheck({...})], preserving its id/slug) and remove its .ts + barrel/display ` +
        `entries from the pack. If the rule genuinely applies to arbitrary customer ` +
        `codebases, rewrite it to drop the opensip-specific facts; for a true exception, add ` +
        `@fitness-ignore-file shipped-checks-must-be-generic with a justification.`,
      type: 'shipped-checks-must-be-generic',
    },
  ];
}

export const checks = [
  defineCheck({
    id: '270cf3d8-d8eb-4019-b0a3-0920a44c2c88',
    slug: 'shipped-checks-must-be-generic',
    description:
      'A check in the shipped @opensip-cli/checks-* packs must apply to arbitrary customer codebases — it must not hardcode opensip-cli paths, ADRs, spec sections, or internal engine packages (those belong in project-local .mjs self-checks)',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'checks', 'meta'],
    fileTypes: ['ts', 'tsx'],
    // raw: ADR/§/path signals live in comments AND code; authoring-import lines
    // are filtered inside the analyzer, not by content stripping.
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeShippedChecksMustBeGeneric(content, filePath),
  }),
];
