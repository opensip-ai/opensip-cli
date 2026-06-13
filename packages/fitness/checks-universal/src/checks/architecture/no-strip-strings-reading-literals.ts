/**
 * @fileoverview A check that declares `contentFilter: 'strip-strings'` (or
 * `'strip-strings-and-comments'`) must NOT inspect string-literal CONTENT — the
 * engine blanks that content before `analyze` runs, so the detection silently
 * matches nothing in production.
 *
 * WHY (the drift this freezes out):
 *   `strip-strings` replaces every string-literal body with equal-length
 *   whitespace BEFORE `analyze(content, filePath)` is called. A check that then
 *   reads a string literal's text — `ts.isStringLiteral(node) && node.text === …`,
 *   `getTemplateText(node)`, etc. — sees blanks, so its guard never fires and it
 *   returns `[]` for every file. This is how `sql-injection` (a CRITICAL security
 *   gate) and `incomplete-regex-escaping` became silent no-ops in production while
 *   their unit tests (which run with no adapter → raw content) stayed green. This
 *   meta-check fails the build loudly the next time a check pairs `strip-strings`
 *   with string-literal inspection.
 *
 * DETECTION — regex on RAW content (the `contentFilter` value and the TS API
 * calls ARE the signal, so they must not be stripped; comment lines are skipped):
 *   a check file that BOTH (a) declares a `strip-strings`/`strip-strings-and-
 *   comments` contentFilter AND (b) inspects string-literal nodes via the TS API
 *   (`isStringLiteral` / `isStringLiteralLike` / `isNoSubstitutionTemplateLiteral`
 *   / `isTemplateExpression` / `getTemplateText`). A check that reads literal
 *   content under `contentFilter: 'raw'` is correct and never matches (no
 *   strip-strings); a strip-strings check that inspects only identifiers/AST
 *   shape (not string-literal content) never matches either.
 *
 * SCOPE — TypeScript check-definition sources (the same meta-check home as
 * `no-placeholder-check-ids`). The TS API surface it keys on (`defineCheck`,
 * `ts.isStringLiteral`) is the public check-authoring contract, so it is useful
 * for any opensip-cli check author, not only this repo. Test files are skipped.
 */
import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

/** Test-file fragments — skipped. */
const TEST_PATH = /(?:\.test\.tsx?$|\/__tests__\/)/;

/** A `contentFilter: 'strip-strings'` / `'strip-strings-and-comments'` declaration. */
const STRIP_STRINGS_FILTER_RE = /contentFilter:\s*(['"])strip-strings(?:-and-comments)?\1/;

/** TS-API shapes that inspect a STRING-LITERAL node (whose content strip-strings blanks). */
const STRING_LITERAL_INSPECTION_RE =
  /\b(?:isStringLiteral|isStringLiteralLike|isNoSubstitutionTemplateLiteral|isTemplateExpression|getTemplateText)\b/;

/** A line is comment-only (so prose mentioning the patterns does not fire). */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
}

/**
 * Pure analysis over one check-definition source file. Flags the
 * `contentFilter` declaration line when the file also inspects string-literal
 * content. Exported for unit tests.
 */
export function analyzeNoStripStringsReadingLiterals(
  content: string,
  filePath: string,
): CheckViolation[] {
  if (TEST_PATH.test(filePath.replaceAll('\\', '/'))) return [];

  const lines = content.split('\n');
  const codeLines = lines.map((l) => (isCommentLine(l) ? '' : l));

  // (b) does the file inspect string-literal content anywhere (in code)?
  const inspectsLiterals = codeLines.some((l) => STRING_LITERAL_INSPECTION_RE.test(l));
  if (!inspectsLiterals) return [];

  // (a) flag each strip-strings contentFilter declaration line.
  const violations: CheckViolation[] = [];
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

export const noStripStringsReadingLiterals = defineCheck({
  id: '8fc4ce8d-65ce-427d-bd1e-0cebba1f352f',
  slug: 'no-strip-strings-reading-literals',
  description:
    "A check declaring contentFilter 'strip-strings' must not inspect string-literal content — the engine blanks it before analyze(), making the check a silent no-op (the sql-injection/incomplete-regex-escaping class)",
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture', 'checks', 'meta'],
  fileTypes: ['ts', 'tsx'],
  // raw: the contentFilter VALUE and the TS-API call names are the signal — a
  // strip-strings filter here would blank the very tokens we match. Comment
  // lines are neutralized in the analyzer so prose does not false-fire.
  contentFilter: 'raw',
  analyze: (content, filePath) => analyzeNoStripStringsReadingLiterals(content, filePath),
});
