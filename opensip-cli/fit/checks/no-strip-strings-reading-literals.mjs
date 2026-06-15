/**
 * @fileoverview no-strip-strings-reading-literals — a check declaring
 *               `contentFilter: 'strip-strings'` must not inspect string-literal
 *               content. Project-local SELF-check (meta).
 *
 * Lives here (not in the shipped `@opensip-cli/checks-*` packs) because it keys
 * on opensip-cli' OWN check-authoring API (`defineCheck`, the `contentFilter`
 * filter values, and the `ts.is*StringLiteral` inspection shapes) and its
 * primary job is to guard opensip-cli' own ~165-check corpus. It is the meta
 * sibling of `no-placeholder-check-ids`.
 *
 * WHY: `strip-strings` replaces every string-literal body with whitespace BEFORE
 * `analyze(content, filePath)` runs. A check that then reads a literal's text
 * (`ts.isStringLiteral(node) && node.text === …`, `getTemplateText(node)`) sees
 * blanks, so its guard never fires and it returns `[]` for every file. This is
 * how `sql-injection` (a CRITICAL gate) and `incomplete-regex-escaping` became
 * silent no-ops in production while their no-adapter unit tests (raw content)
 * stayed green. This meta-check fails the build the next time a check pairs
 * `strip-strings` with string-literal inspection.
 *
 * `raw` content: the `contentFilter` value and the TS-API call names ARE the
 * signal — a strip-strings filter here would blank the tokens we match. Comment
 * lines are neutralized in the analyzer so prose does not false-fire.
 */
import { defineCheck } from '@opensip-cli/fitness';

/** Test-file fragments — skipped. */
const TEST_PATH = /(?:\.test\.tsx?$|\/__tests__\/)/;

/** A `contentFilter: 'strip-strings'` / `'strip-strings-and-comments'` declaration. */
const STRIP_STRINGS_FILTER_RE = /contentFilter:\s*(['"])strip-strings(?:-and-comments)?\1/;

/** TS-API shapes that inspect a STRING-LITERAL node (whose content strip-strings blanks). */
const STRING_LITERAL_INSPECTION_RE =
  /\b(?:isStringLiteral|isStringLiteralLike|isNoSubstitutionTemplateLiteral|isTemplateExpression|getTemplateText)\b/;

/** A line is comment-only (so prose mentioning the patterns does not fire). */
function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
}

/** Pure analysis. Exported for direct exercise if this check grows a test harness. */
export function analyzeNoStripStringsReadingLiterals(content, filePath) {
  if (TEST_PATH.test(filePath.replaceAll('\\', '/'))) return [];

  const lines = content.split('\n');
  const codeLines = lines.map((l) => (isCommentLine(l) ? '' : l));

  // (b) does the file inspect string-literal content anywhere (in code)?
  const inspectsLiterals = codeLines.some((l) => STRING_LITERAL_INSPECTION_RE.test(l));
  if (!inspectsLiterals) return [];

  // (a) flag each strip-strings contentFilter declaration line.
  const violations = [];
  for (const [i, line] of codeLines.entries()) {
    if (!STRIP_STRINGS_FILTER_RE.test(line)) continue;
    violations.push({
      line: i + 1,
      message:
        "This check declares a 'strip-strings' content filter but also inspects " +
        'string-literal content (isStringLiteral / getTemplateText / …). The engine ' +
        'blanks string-literal bodies before analyze() runs, so the detection matches ' +
        'nothing in production — the check becomes a silent no-op (its no-adapter unit ' +
        'tests stay green because they run on raw content).',
      severity: 'error',
      suggestion:
        "Use contentFilter: 'raw' (or 'none') for a check that reads string-literal " +
        'content — the AST already structurally distinguishes literals, so stripping is ' +
        'unnecessary and actively breaks detection. Then assert the check fires through ' +
        'the FILTERED path (register the language adapter in the test scope).',
      type: 'no-strip-strings-reading-literals',
    });
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: '8fc4ce8d-65ce-427d-bd1e-0cebba1f352f',
    slug: 'no-strip-strings-reading-literals',
    description:
      "A check declaring contentFilter 'strip-strings' must not inspect string-literal content — the engine blanks it before analyze(), making the check a silent no-op (the sql-injection/incomplete-regex-escaping class)",
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'checks', 'meta'],
    fileTypes: ['ts', 'tsx'],
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeNoStripStringsReadingLiterals(content, filePath),
  }),
];
