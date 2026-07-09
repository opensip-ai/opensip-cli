/**
 * @fileoverview presentation-labels-via-format — human duration/score labels
 *   must come from @opensip-cli/format (ADR-0144). Project-local SELF-check.
 *
 * Labels, not meaning: suite aggregation stays in dashboard/host code; this
 * check only blocks ad-hoc duration/score *string* construction outside
 * packages/format/.
 *
 * Uses raw content (no strip-strings-and-comments): the anti-patterns depend on
 * literal `'s'`, `'%'`, and template text that stripping would blank.
 */
import { defineCheck } from "@opensip-cli/fitness";

const TEST_PATH = /(?:\.test\.tsx?$|\/__tests__\/|\/__fixtures__\/)/;
const ALLOW_PATH = [
  /packages\/format\//,
  /client-bundle\.generated\.ts$/,
  /scripts\/perf\//,
  /docs\//,
];

/**
 * Anti-patterns for human duration/score labels. Ordered for readable messages.
 * Intentionally does not ban CSS width percentages (`width: … + rate + '%'`) —
 * those lines are skipped via WIDTH_STYLE_LINE.
 */
const PATTERNS = [
  [/durationMs\s*\/\s*1000/, "durationMs / 1000 human label"],
  [
    /\.toFixed\s*\(\s*1\s*\)\s*\+\s*['"]s['"]/,
    ".toFixed(1) + 's' human duration label",
  ],
  [/\bfunction\s+formatDuration\s*\(/, "local formatDuration function"],
  [/\bscore\s*\+\s*['"]%['"]/, "score + '%' human score label"],
  [/\$\{\s*(?:s\.)?score\s*\}%/, "`${score}%` human score label"],
  // Suite step style: `${Math.round(step.durationMs)}ms` or durationMs + 'ms'
  [
    /Math\.round\s*\(\s*[^)]*durationMs[^)]*\)/,
    "Math.round(durationMs) ad-hoc ms label",
  ],
  [/durationMs\s*\+\s*['"]ms['"]/, "durationMs + 'ms' ad-hoc label"],
  [/\$\{[^}]*durationMs[^}]*\}ms/, "template durationMs…ms ad-hoc label"],
  // Recipe/catalog timeout (ms) rendered as seconds without formatDuration
  [/\btimeout\s*\/\s*1000/, "timeout / 1000 human duration label"],
  [/\/\s*1000\s*\+\s*['"]s['"]/, "/ 1000 + 's' human duration label"],
  // Pass-rate / percentage display (not CSS width — see WIDTH_STYLE_LINE skip)
  [/\brate\s*\+\s*['"]%['"]/, "rate + '%' human percent label"],
  [/\$\{\s*rate\s*\}%/, "`${rate}%` human percent label"],
];

/** CSS width percentage construction — not a presentation score label. */
const WIDTH_STYLE_LINE = /\bwidth\s*:/;

export function analyzePresentationLabelsViaFormat(content, filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  if (TEST_PATH.test(normalized)) return [];
  if (ALLOW_PATH.some((re) => re.test(normalized))) return [];
  // Only first-party presentation-ish packages — keep precision high.
  if (
    !/packages\/(?:dashboard|cli-ui|cli|mcp)\//.test(normalized) &&
    !/packages\/(?:fitness|graph|simulation|yagni)\/engine\/src\/cli\//.test(
      normalized,
    )
  ) {
    return [];
  }

  const violations = [];
  for (const [i, line] of content.split("\n").entries()) {
    if (WIDTH_STYLE_LINE.test(line) && /\brate\s*\+/.test(line)) {
      // e.g. 'width:' + rate + '%' — layout, not a shared score label.
      continue;
    }
    for (const [re, kind] of PATTERNS) {
      re.lastIndex = 0;
      if (!re.test(line)) continue;
      violations.push({
        line: i + 1,
        message:
          `Ad-hoc ${kind} outside @opensip-cli/format (ADR-0144). ` +
          "CLI, report, and host history must share one lexical label path.",
        severity: "error",
        suggestion:
          "Import formatDuration / formatScore / projectSessionDisplay from " +
          "'@opensip-cli/format'. Do not re-round durationMs or hand-build score strings. " +
          "Exempt with @fitness-ignore-file presentation-labels-via-format only with reason.",
        type: "presentation-labels-via-format",
      });
      break;
    }
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: "a14b4c0e-5f21-4d8a-9e3b-7c1d2a0f6b88",
    slug: "presentation-labels-via-format",
    description:
      "Human duration/score labels must use @opensip-cli/format (ADR-0144); no ad-hoc toFixed or score+'%' in presentation packages",
    scope: { languages: ["typescript"], concerns: ["backend"] },
    tags: ["architecture"],
    fileTypes: ["ts", "tsx"],
    // Raw content: anti-patterns depend on string literals ('s', '%', template tails).
    analyze: (content, filePath) =>
      analyzePresentationLabelsViaFormat(content, filePath),
  }),
];
