/**
 * @fileoverview An `OptionSpec` whose description advertises a REPEATABLE flag
 * must declare an array accumulator (`arrayDefault` + `parse`, or `variadic`) —
 * otherwise Commander keeps only the LAST occurrence and the earlier values are
 * silently dropped.
 *
 * WHY (the drift this freezes out):
 *   A value option declared without an `argParser` reducer yields a single
 *   string from Commander — the LAST `--flag X` wins. So an OptionSpec that says
 *   "repeatable" / "composable" in its description but omits `arrayDefault` +
 *   `parse` produces `{ flag: 'top:20' }` for `--filter errors-only --filter
 *   top:20`: the `errors-only` value is silently discarded. The correctly-wired
 *   sibling (`--exclude`, `arrayDefault: []` + `parse: (v, prev) => [...prev, v]`)
 *   accumulates. This check fails the build when a repeatable flag forgets the
 *   accumulator.
 *
 * DETECTION — regex on RAW content (the `flag`/`description` string VALUES are
 * the signal, so they must not be stripped; comment lines are skipped). For each
 * `flag: '--…'` declaration, the enclosing OptionSpec block (bounded by the next
 * `flag:` or a short window) is inspected: if the description advertises repeat
 * intent (`repeatable` / `repeated` / `composable` / `comma-separated` /
 * `accumulate…`) but the block declares neither `arrayDefault`, nor `parse`, nor
 * `variadic`, it is flagged.
 *
 * SCOPE — TypeScript backend/CLI sources (where `OptionSpec`s are declared). This
 * is a generic command-plane contract, so there is no repo-specific path guard.
 * Test files are skipped.
 */
import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

/** Test-file fragments — skipped. */
const TEST_PATH = /(?:\.test\.tsx?$|\/__tests__\/)/;

/** A `flag: '--something'` OptionSpec property (long flag → repeatable-capable). */
const FLAG_DECL_RE = /\bflag:\s*(['"])(-[^'"]*--[^'"]+|--[^'"]+)\1/;

/** Description advertises that the flag may be supplied more than once. */
const REPEAT_INTENT_RE = /\b(?:repeatable|repeated|composable|comma-separated|accumulat\w*)\b/i;

/** An array accumulator: Commander needs one of these for a repeatable value option. */
const ACCUMULATOR_RE = /\b(?:arrayDefault|parse|variadic)\b/;

function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
}

/**
 * Pure analysis over one source file. Flags a repeatable-intent OptionSpec that
 * lacks an array accumulator. Exported for unit tests.
 */
export function analyzeRepeatableOptionNeedsAccumulator(
  content: string,
  filePath: string,
): CheckViolation[] {
  if (TEST_PATH.test(filePath.replaceAll('\\', '/'))) return [];

  const rawLines = content.split('\n');
  // Neutralize comment lines so a doc-comment's prose ("repeatable") does not
  // count as the OptionSpec description.
  const lines = rawLines.map((l) => (isCommentLine(l) ? '' : l));

  // Indices of every `flag: '--…'` declaration — each opens an OptionSpec block.
  const flagIdx = lines
    .map((l, i) => (FLAG_DECL_RE.test(l) ? i : -1))
    .filter((i) => i >= 0);

  const violations: CheckViolation[] = [];
  for (let k = 0; k < flagIdx.length; k++) {
    const start = flagIdx[k];
    // The block runs to the next OptionSpec's flag line, capped at 16 lines so a
    // missing next flag (last option in the list) still bounds the window.
    const next = flagIdx[k + 1] ?? lines.length;
    const end = Math.min(next, start + 16);
    const block = lines.slice(start, end).join('\n');

    if (REPEAT_INTENT_RE.test(block) && !ACCUMULATOR_RE.test(block)) {
      violations.push({
        line: start + 1,
        message:
          'This OptionSpec describes a repeatable flag but declares no array ' +
          'accumulator (arrayDefault + parse, or variadic). Commander keeps only the ' +
          'LAST occurrence of a value option without an argParser, so earlier values ' +
          'are silently dropped (e.g. `--filter a --filter b` yields only `b`).',
        severity: 'error',
        suggestion:
          'Add an accumulator: `arrayDefault: []` and ' +
          '`parse: (val, prev) => [...(prev as string[]), val]` (the shape `--exclude` ' +
          'uses), or mark the option `variadic: true` if it takes space-separated values.',
        type: 'repeatable-option-needs-accumulator',
      });
    }
  }
  return violations;
}

export const repeatableOptionNeedsAccumulator = defineCheck({
  id: '90a8343c-65d5-4b62-94f1-6a47af50c41e',
  slug: 'repeatable-option-needs-accumulator',
  description:
    'An OptionSpec whose description advertises a repeatable flag must declare an array accumulator (arrayDefault + parse, or variadic) — else Commander silently drops all but the last value',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture'],
  fileTypes: ['ts'],
  // raw: the flag and description string VALUES are the signal — strip-strings
  // would blank them. Comment lines are neutralized in the analyzer.
  contentFilter: 'raw',
  analyze: (content, filePath) => analyzeRepeatableOptionNeedsAccumulator(content, filePath),
});
