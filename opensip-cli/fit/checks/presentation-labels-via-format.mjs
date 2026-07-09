/**
 * @fileoverview presentation-labels-via-format — human duration/score labels
 *   must come from @opensip-cli/format (ADR-0144). Project-local SELF-check.
 *
 * Labels, not meaning: suite aggregation stays in dashboard/host code; this
 * check only blocks ad-hoc duration/score *string* construction outside
 * packages/format/.
 */
import { defineCheck } from '@opensip-cli/fitness';

const TEST_PATH = /(?:\.test\.tsx?$|\/__tests__\/|\/__fixtures__\/)/;
const ALLOW_PATH = [
  /packages\/format\//,
  /client-bundle\.generated\.ts$/,
  /scripts\/perf\//,
  /docs\//,
];

/** durationMs / 1000 used for human labels (not catalog provenance wall clocks). */
const DURATION_DIV_RE = /durationMs\s*\/\s*1000/;
/** Classic dashboard/CLI ad-hoc seconds label. */
const TOFIXED_S_RE = /\.toFixed\s*\(\s*1\s*\)\s*\+\s*['"]s['"]/;
/** Local reimplementation of the shared formatter. */
const LOCAL_FORMAT_DURATION_RE = /\bfunction\s+formatDuration\s*\(/;
/** score + '%' style (not template-threshold rates). */
const SCORE_PLUS_PCT_RE = /\bscore\s*\+\s*['"]%['"]/;
/** `${s.score}%` / `${score}%` session-style labels. */
const SCORE_TEMPLATE_RE = /\$\{\s*(?:s\.)?score\s*\}%/;

export function analyzePresentationLabelsViaFormat(content, filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  if (TEST_PATH.test(normalized)) return [];
  if (ALLOW_PATH.some((re) => re.test(normalized))) return [];
  // Only first-party presentation-ish packages — keep precision high.
  if (
    !/packages\/(?:dashboard|cli-ui|cli|mcp)\//.test(normalized) &&
    !/packages\/(?:fitness|graph|simulation|yagni)\/engine\/src\/cli\//.test(normalized)
  ) {
    return [];
  }

  const violations = [];
  for (const [i, line] of content.split('\n').entries()) {
    const patterns = [
      [DURATION_DIV_RE, 'durationMs / 1000 human label'],
      [TOFIXED_S_RE, ".toFixed(1) + 's' human duration label"],
      [LOCAL_FORMAT_DURATION_RE, 'local formatDuration function'],
      [SCORE_PLUS_PCT_RE, "score + '%' human score label"],
      [SCORE_TEMPLATE_RE, '`${score}%` human score label'],
    ];
    for (const [re, kind] of patterns) {
      re.lastIndex = 0;
      if (!re.test(line)) continue;
      violations.push({
        line: i + 1,
        message:
          `Ad-hoc ${kind} outside @opensip-cli/format (ADR-0144). ` +
          'CLI, report, and host history must share one lexical label path.',
        severity: 'error',
        suggestion:
          "Import formatDuration / formatScore / projectSessionDisplay from " +
          "'@opensip-cli/format'. Do not re-round durationMs or hand-build score strings. " +
          'Exempt with @fitness-ignore-file presentation-labels-via-format only with reason.',
        type: 'presentation-labels-via-format',
      });
      break;
    }
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: 'a14b4c0e-5f21-4d8a-9e3b-7c1d2a0f6b88',
    slug: 'presentation-labels-via-format',
    description:
      'Human duration/score labels must use @opensip-cli/format (ADR-0144); no ad-hoc toFixed or score+\'%\' in presentation packages',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture'],
    fileTypes: ['ts', 'tsx'],
    contentFilter: 'strip-strings-and-comments',
    analyze: (content, filePath) => analyzePresentationLabelsViaFormat(content, filePath),
  }),
];
