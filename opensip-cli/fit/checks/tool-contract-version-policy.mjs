/**
 * @fileoverview tool-contract-version-policy — any *_CONTRACT_VERSION constant
 *               may only change alongside a reference to its governing ADR.
 *               Project-local SELF-check.
 *
 * Relocated out of `@opensip-cli/checks-*` (placement sweep) because it encodes
 * opensip-cli local facts: it hardcodes opensip-cli's OWN governance docs —
 * ADR-0046 (core `TOOL_CONTRACT_VERSION` bus) and ADR-0047 (per-tool versions
 * such as `FITNESS_CONTRACT_VERSION`) — and the exact "Tool Contract Versioning
 * Policy" / "per-tool contract versioning" prose titles those ADRs use. A
 * consumer repo has no ADR-0046/0047 and no `*_CONTRACT_VERSION` bus, so the
 * rule is opensip-internal, not universal. Inert for adopters per
 * opensip-cli/fit/checks/README.md.
 *
 * WHY: a *_CONTRACT_VERSION constant (TOOL_CONTRACT_VERSION for the core Tool
 * bus, plus per-tool versions) may only be changed when the relevant contract
 * actually changes, and the change must be accompanied by a reference to the
 * governing ADR(s) in the immediately preceding comment/JSDoc. See ADR-0046
 * (core) and ADR-0047 (per-tool) for the full policies. The check is
 * deliberately narrow and cheap (pure line scan): it does not attempt to detect
 * "was this a real contract change?" (a judgment call recorded in the ADRs); it
 * only ensures the documentation obligation is met. It fires for any file
 * containing a *_CONTRACT_VERSION definition (core + per-tool sources).
 */
import { defineCheck } from '@opensip-cli/fitness';

/**
 * Pattern that matches *any* *_CONTRACT_VERSION constant (core + per-tool).
 * This allows the same check to cover TOOL_CONTRACT_VERSION (ADR-0046) and
 * future FITNESS_CONTRACT_VERSION / GRAPH_... (ADR-0047) without per-constant
 * duplication.
 */
const VERSION_DEF = /([A-Z_]+CONTRACT_VERSION)\s*=\s*['"][^'"]+['"]/;

/**
 * Strict reference required in the immediately preceding comment/JSDoc.
 * Must mention one of the governing ADRs (or the policy titles) so that a
 * change to any contract version constant is traceable.
 */
const POLICY_REFERENCE =
  /(ADR-0046|ADR-0047|ADR-0074|Tool Contract Versioning Policy|per-tool contract versioning|open domain contract versions)/i;

/**
 * How many lines upward we look for the policy reference in comments.
 * Keeps the check local to the declaration site.
 */
const LOOKBACK_LINES = 12;

/** Pure analysis. Exported for direct exercise if this check grows a test harness. */
export function analyzeToolContractVersionPolicy(content, _filePath) {
  const lines = content.split('\n');
  const violations = [];

  for (const [i, line] of lines.entries()) {
    const match = VERSION_DEF.exec(line);
    if (!match) continue;

    const constName = match[1];

    // Look in the preceding LOOKBACK_LINES for a policy reference inside a
    // comment block (// or /* ... */ or JSDoc).
    const start = Math.max(0, i - LOOKBACK_LINES);
    const window = lines.slice(start, i + 1).join('\n');

    if (!POLICY_REFERENCE.test(window)) {
      violations.push({
        message:
          `${constName} definition is missing a reference to ADR-0046, ADR-0047, or ADR-0074 ` +
          '(or the "Tool Contract Versioning Policy" / "per-tool contract versioning"). ' +
          'Per ADR-0046/0047/0074, changes to any contract version constant must be ' +
          'accompanied by an update to the relevant ADR (or a superseding ADR) and ' +
          'an explicit reference in the comment/JSDoc immediately above the definition.',
        severity: 'error',
        line: i + 1,
        suggestion:
          'Add a comment or extend the JSDoc above the constant with a reference ' +
          'to the governing ADR (0046 for core TOOL_CONTRACT_VERSION, 0047 for per-tool). ' +
          'See the clean fixtures and the JSDoc on the constants for the expected form. ' +
          'If this is an intentional contract change, also update the ADR before landing.',
      });
    }
  }

  return violations;
}

export const checks = [
  defineCheck({
    id: 'c9f2e1a3-7b5d-4f8e-9c1a-2d3e4f5a6b7c', // promoted stable ID (was placeholder for ADR-0046/0047 work)
    slug: 'tool-contract-version-policy',
    description:
      'Any *_CONTRACT_VERSION (core + per-tool) may only be changed on actual contract deltas and the change must reference ADR-0046 or ADR-0047',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'tool-contract', 'versioning', 'plugins'],
    fileTypes: ['ts', 'tsx'],
    analyze: (content, filePath) => analyzeToolContractVersionPolicy(content, filePath),
  }),
];
