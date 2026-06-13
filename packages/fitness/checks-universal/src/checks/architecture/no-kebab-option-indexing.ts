/**
 * @fileoverview A command handler must not index its parsed-options object by a
 * KEBAB-CASE string literal — Commander camelCases long flags, so the kebab key
 * is always `undefined`.
 *
 * WHY (the drift this freezes out):
 *   Commander stores `--summary-only` under `opts.summaryOnly`, `--report-to`
 *   under `opts.reportTo`, etc. — it camelCases the long flag when it builds the
 *   parsed-options object. A handler that reads `opts['summary-only']` therefore
 *   reads a key Commander NEVER sets: the value is silently `undefined`, the flag
 *   becomes a permanent no-op, and the bug is invisible (no crash, no warning).
 *   This is a recurring CLI footgun whenever a multi-word flag is wired by hand.
 *
 * DETECTION — regex on RAW content (the kebab string literal IS the signal, so it
 * must NOT be stripped; comment lines are skipped manually). Flags an index
 * access on a Commander-convention options identifier (`opts` / `rawOpts` /
 * `cmdOpts` / `parsedOpts` / `cmdOptions`) whose key is a kebab-case string
 * literal (`['a-b']`). camelCase keys, numeric keys, and non-options objects
 * (`headers['content-type']`, `style['font-size']`) do not match.
 *
 * SCOPE — TypeScript backend/CLI sources. This is a generic Commander
 * best-practice (a kebab-indexed parsed-options read is wrong in any
 * Commander-based CLI), so there is no repo-specific path guard. Test files are
 * skipped.
 */
import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

/** Test-file fragments — skipped. */
const TEST_PATH = /(?:\.test\.tsx?$|\/__tests__\/)/;

/**
 * `<optsVar>['<kebab-case>']` — a parsed-options index by a kebab string literal.
 * The identifier set is the Commander parsed-options naming convention; the key
 * must contain at least one `-` (kebab), which a camelCased Commander key never
 * does.
 */
const KEBAB_OPTION_INDEX_RE =
  /\b(?:opts|rawOpts|cmdOpts|parsedOpts|cmdOptions)\s*\[\s*(['"])([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\1\s*\]/g;

/**
 * Pure analysis over one source file. Returns a finding for each kebab-indexed
 * parsed-options read. Exported for unit tests.
 */
export function analyzeNoKebabOptionIndexing(content: string, filePath: string): CheckViolation[] {
  if (TEST_PATH.test(filePath.replaceAll('\\', '/'))) return [];

  const violations: CheckViolation[] = [];
  const lines = content.split('\n');
  for (const [i, rawLine] of lines.entries()) {
    // Skip comment lines so prose/examples mentioning the pattern don't fire
    // (content is raw, so the kebab literal survives — we must comment-skip here).
    const trimmed = rawLine.trimStart();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
    KEBAB_OPTION_INDEX_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = KEBAB_OPTION_INDEX_RE.exec(rawLine)) !== null) {
      const kebabKey = m[2];
      const camel = kebabKey.replaceAll(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
      violations.push({
        line: i + 1,
        message:
          `Parsed options indexed by the kebab-case key '${kebabKey}'. Commander ` +
          `camelCases long flags, so it stores this under '${camel}' — the kebab key is ` +
          `always undefined and the flag is a silent no-op.`,
        severity: 'error',
        suggestion: `Read the camelCased key Commander actually sets: 'opts.${camel}'.`,
        type: 'no-kebab-option-indexing',
      });
    }
  }
  return violations;
}

export const noKebabOptionIndexing = defineCheck({
  id: '64bb7fa7-3e0d-4f4d-a1e6-d7b189df053c',
  slug: 'no-kebab-option-indexing',
  description:
    'Command handlers must not index parsed options by a kebab-case key — Commander camelCases long flags, so the kebab key is always undefined (silent no-op flag)',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture'],
  fileTypes: ['ts'],
  // raw: the kebab-case string literal IS the signal — strip-strings would blank
  // it. Comment lines are skipped in the analyzer so prose does not false-fire.
  contentFilter: 'raw',
  analyze: (content, filePath) => analyzeNoKebabOptionIndexing(content, filePath),
});
