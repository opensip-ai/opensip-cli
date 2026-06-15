/**
 * @fileoverview repeatable-option-needs-accumulator — an OptionSpec whose
 *               description says it is repeatable must declare an array
 *               accumulator. Project-local SELF-check.
 *
 * Lives here (not in the shipped `@opensip-cli/checks-*` packs) because it keys
 * on opensip-cli' OWN command-plane shape: the `OptionSpec` object literal
 * (`flag` / `value` / `description` / `arrayDefault` / `parse` / `variadic`)
 * from `@opensip-cli/core` tools. A consumer that wires Commander directly does
 * not use that shape, so the rule is opensip-internal.
 *
 * WHY: a value option declared without an `argParser` reducer yields a single
 * string from Commander — the LAST `--flag X` wins. So an OptionSpec that
 * advertises "repeatable" / "composable" but omits `arrayDefault` + `parse`
 * silently drops every value except the last (`--filter a --filter b` → only
 * `b`). The correctly-wired sibling (`--exclude`) declares
 * `arrayDefault: []` + `parse: (v, prev) => [...prev, v]` and accumulates.
 *
 * `raw` content: the `flag`/`description` string VALUES are the signal, so they
 * must not be stripped. Comment lines are neutralized in the analyzer.
 */
import { defineCheck } from '@opensip-cli/fitness';

/** Test-file fragments — skipped. */
const TEST_PATH = /(?:\.test\.tsx?$|\/__tests__\/)/;

/**
 * A `flag: '<value>'` OptionSpec property. The quoted value is captured (the
 * `\1` closing-quote backref makes `[^'"]*` unambiguous — no super-linear
 * backtracking); a long flag is then detected by testing the value for `--`.
 */
const FLAG_VALUE_RE = /\bflag:\s*(['"])([^'"]*)\1/;

/** Description advertises that the flag may be supplied more than once. */
const REPEAT_INTENT_RE = /\b(?:repeatable|repeated|composable|comma-separated|accumulat\w*)\b/i;

/** An array accumulator: Commander needs one of these for a repeatable value option. */
const ACCUMULATOR_RE = /\b(?:arrayDefault|parse|variadic)\b/;

function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
}

/** Pure analysis. Exported for direct exercise if this check grows a test harness. */
export function analyzeRepeatableOptionNeedsAccumulator(content, filePath) {
  if (TEST_PATH.test(filePath.replaceAll('\\', '/'))) return [];

  const rawLines = content.split('\n');
  // Neutralize comment lines so a doc-comment's prose ("repeatable") does not
  // count as the OptionSpec description.
  const lines = rawLines.map((l) => (isCommentLine(l) ? '' : l));

  // Indices of every `flag: '--…'` declaration (a long flag) — each opens an
  // OptionSpec block.
  const flagIdx = [];
  for (const [i, l] of lines.entries()) {
    const m = FLAG_VALUE_RE.exec(l);
    if (m?.[2]?.includes('--')) flagIdx.push(i);
  }

  const violations = [];
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
          '`parse: (val, prev) => [...(prev), val]` (the shape `--exclude` uses), or ' +
          'mark the option `variadic: true` if it takes space-separated values.',
        type: 'repeatable-option-needs-accumulator',
      });
    }
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: '90a8343c-65d5-4b62-94f1-6a47af50c41e',
    slug: 'repeatable-option-needs-accumulator',
    description:
      'An OptionSpec whose description advertises a repeatable flag must declare an array accumulator (arrayDefault + parse, or variadic) — else Commander silently drops all but the last value',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture'],
    fileTypes: ['ts'],
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeRepeatableOptionNeedsAccumulator(content, filePath),
  }),
];
