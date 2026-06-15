/**
 * @fileoverview defineRegexListCheck - Template helper for regex-list scanners.
 *
 * Wraps {@link defineCheck} for the common "for line; for pattern; emit one
 * violation per match" shape that ~13 sites in @opensip-cli/checks-universal
 * (and a handful in @opensip-cli/checks-typescript) reimplement, often with
 * subtly different `lastIndex`-reset, comment-skip, and test-file-skip
 * semantics.
 *
 * Adopters declare patterns with {@link RegexListCheckPattern} tuples; this
 * helper handles iteration, regex state reset, optional comment/test-file
 * skipping, and per-pattern slug tagging in the violation `type` field.
 *
 * The shape mirrors the existing `no-console-log.ts` reference: each pattern
 * has its own `id` (UUID) and `slug`. The pattern's `slug` is emitted on
 * each violation as `type: pattern.slug`, matching the established
 * convention used by `heavy-import-detection` (`type: 'HEAVY_IMPORT' | ...`).
 * The `id` is purely descriptive metadata for the pattern author and is
 * not added to violation output.
 *
 * @example
 * ```typescript
 * export const noConsoleLog = defineRegexListCheck({
 *   id: '86403377-5903-478a-bdf2-e4f2f17df39f',
 *   slug: 'no-console-log',
 *   description: 'Disallow console.log in production code',
 *   tags: ['logging', 'quality'],
 *   scope: { languages: ['typescript'], concerns: ['backend'] },
 *   fileTypes: ['ts'],
 *   contentFilter: 'strip-strings',
 *   options: { skipCommentLines: true },
 *   patterns: [
 *     {
 *       id: '38b2df63-54c3-4ab9-8a4d-5050384fa56b',
 *       slug: 'console-log',
 *       regex: /console\.log\s{0,10}\(/g,
 *       message: 'console.log detected',
 *       suggestion: 'Use a structured logger',
 *     },
 *     // ... more patterns
 *   ],
 * })
 * ```
 */

import { isCommentLine } from '../check-utils/source-analysis.js';
import { isTestFile } from '../check-utils/test-helpers.js';

import { defineCheck } from './define-check.js';

import type { CheckScope, CheckViolation } from './check-config.js';
import type { Check } from './check-types.js';

/**
 * A single regex pattern entry consumed by {@link defineRegexListCheck}.
 *
 * Each entry has a stable UUID `id` and a kebab-case `slug` so the pattern
 * is individually addressable for documentation and developer tooling. The
 * `slug` is emitted on every produced violation as `type: pattern.slug`.
 *
 * @remarks Per-pattern attribution (e.g. an Aristotle SDO/SAX `provider`)
 * is intentionally NOT modelled here. The `provider` on
 * {@link DefineRegexListCheckConfig} is **check-level only** — every
 * pattern in a single helper invocation shares the same provider. Splitting
 * a pattern list into two helpers is the supported workaround when one
 * subset needs distinct attribution. A per-pattern field will be added
 * if/when a real driver appears (audit 2026-05-23 F1).
 */
export interface RegexListCheckPattern {
  /** Stable UUID identifying this pattern. Purely descriptive. */
  readonly id: string;
  /** Kebab-case slug for this pattern (e.g. `'console-log'`). Emitted as `type` on each violation. */
  readonly slug: string;
  /** Regex executed against each (non-skipped) line. Global flag is recommended for multi-match-per-line behaviour. */
  readonly regex: RegExp;
  /** Violation message reported on a match. */
  readonly message: string;
  /** Optional suggestion text for the violation. */
  readonly suggestion?: string;
  /**
   * Per-pattern severity. Defaults to `'warning'`. Pattern-level severity
   * is preferred over a per-check default because most adopters mix
   * error-class and warning-class patterns inside the same regex list.
   */
  readonly severity?: 'error' | 'warning';
}

/**
 * Options governing line iteration in {@link defineRegexListCheck}.
 */
export interface RegexListCheckOptions {
  /**
   * Skip lines that {@link isCommentLine} reports as comments.
   * Default: `true`.
   */
  readonly skipCommentLines?: boolean;
  /**
   * Skip files that {@link isTestFile} reports as test files. Useful for
   * checks that should not run against `*.test.ts` / `*.spec.ts` /
   * `__tests__/` paths.
   * Default: `false`.
   */
  readonly skipTestFiles?: boolean;
  /**
   * Custom file-path predicate. When provided AND it returns `true`,
   * the file is skipped entirely. Used by sites with site-specific
   * allowlists that the helper does not model (e.g. CLI-output paths
   * like `/commands/`, `/display/`, `/bin/`).
   *
   * The predicate runs once per file before any line iteration.
   */
  readonly skipFile?: (filePath: string) => boolean;
  /**
   * Additional per-line skip predicate evaluated AFTER comment/test
   * filters but BEFORE pattern matching. Use for site-specific filters
   * the helper doesn't model (e.g. `no-window-alert` skips lines
   * starting with `import `).
   */
  readonly skipLine?: (trimmedLine: string, rawLine: string) => boolean;
  /**
   * When `true`, after a violation is emitted on a line, skip remaining
   * patterns for that line — at most one violation per line in total.
   * Use for sites that historically emit one violation per line across
   * all patterns (e.g. `no-window-alert`, `no-eval`).
   *
   * Note this short-circuits at the line level, NOT the pattern level:
   * within a single pattern's match loop (relevant only for global
   * regexes), multiple matches are still emitted before the next line
   * starts. Combine with non-global regexes for true "one per line".
   *
   * Default: `false` (each matching pattern emits its own violation).
   */
  readonly oneViolationPerLine?: boolean;
}

/**
 * Configuration accepted by {@link defineRegexListCheck}.
 *
 * The fields above `patterns` mirror {@link defineCheck}'s analyze-mode
 * `BaseCheckConfig`. The `analyze` function is synthesised by this helper.
 */
export interface DefineRegexListCheckConfig {
  readonly id: string;
  readonly slug: string;
  readonly description: string;
  readonly longDescription?: string;
  readonly tags: readonly string[];
  readonly scope?: CheckScope;
  readonly fileTypes?: readonly string[];
  readonly contentFilter?: 'raw' | 'strip-strings' | 'strip-strings-and-comments';
  readonly confidence?: 'high' | 'medium' | 'low';
  readonly disabled?: boolean;
  readonly timeout?: number;
  readonly docs?: string;
  /**
   * Aristotle SDO/SAX provider attribution applied to every pattern in
   * this check. **Check-level only** — there is no per-pattern override.
   * If two pattern subsets need distinct attribution, define them as two
   * separate checks (audit 2026-05-23 F1).
   */
  readonly provider?: string;
  /** The list of regex patterns to scan each line against. */
  readonly patterns: readonly RegexListCheckPattern[];
  /** Line- and file-level skip toggles. */
  readonly options?: RegexListCheckOptions;
}

/**
 * Build a {@link Check} that scans every line of every matched file
 * against a list of regex patterns and emits one violation per match.
 *
 * Iteration semantics:
 *  - For each line in the file content (split on `\n`).
 *  - Optionally skip lines that {@link isCommentLine} flags as comments
 *    (controlled by `options.skipCommentLines`, default `true`).
 *  - For each pattern: reset `pattern.regex.lastIndex = 0`, then iterate
 *    `pattern.regex.exec(line)` until it returns `null`. This produces
 *    one violation per match for global-flag regexes, and exactly one
 *    violation when the regex has no global flag (because non-global
 *    `exec` always starts at position 0). Resetting `lastIndex` is
 *    required because pattern objects are reused across lines and
 *    files; the audit notes several existing sites get this wrong.
 *
 * Optionally skip whole files when `options.skipTestFiles` is `true` and
 * {@link isTestFile} returns true for the file path.
 *
 * @remarks This helper synthesises only `defineCheck`'s **per-file
 * `analyze` mode** — it processes one file at a time, with no awareness
 * of cross-file state. Cross-file regex-list semantics (e.g. correlated
 * patterns across `package.json` + `Dockerfile`) are out of scope; an
 * `analyzeAll`-mode wrapper would be a separate helper. The factor-out
 * point if/when one is needed is `processFile` (the per-file pure
 * function) — call it from an `analyzeAll` callback that walks an
 * accessor (audit 2026-05-23 F8).
 *
 * @throws {ValidationError} via {@link defineCheck} when the synthesised
 *   config is invalid.
 */
/**
 * Match a single pattern against a single line, pushing one violation
 * per match into `violations`. For global regexes this emits multiple
 * violations per line; for non-global regexes it emits at most one.
 *
 * When `singleMatch` is true, only the first match is emitted (used for
 * `oneViolationPerLine` semantics).
 *
 * Returns `true` if at least one violation was pushed.
 */
function matchPatternOnLine(
  pattern: RegexListCheckPattern,
  line: string,
  lineNum: number,
  violations: CheckViolation[],
  singleMatch: boolean,
): boolean {
  // Reset lastIndex — pattern objects are reused across lines and files;
  // failing to reset would skip matches at low positions on subsequent
  // calls.
  pattern.regex.lastIndex = 0;
  let pushed = false;
  let match = pattern.regex.exec(line);
  while (match !== null) {
    violations.push({
      line: lineNum,
      column: match.index,
      message: pattern.message,
      severity: pattern.severity ?? 'warning',
      suggestion: pattern.suggestion,
      match: match[0],
      type: pattern.slug,
    });
    pushed = true;
    // Non-global regex: stop after the first match. Otherwise exec
    // would loop forever (lastIndex stays at 0).
    if (!pattern.regex.global) break;
    if (singleMatch) break;
    match = pattern.regex.exec(line);
  }
  return pushed;
}

/**
 * Process every line of `content` against the supplied pattern list,
 * applying the configured skip predicates. Pulled out of the main
 * factory function to keep cognitive complexity below the workspace
 * threshold; pure logic.
 */
interface ProcessFileOptions {
  readonly content: string;
  readonly patterns: readonly RegexListCheckPattern[];
  readonly skipComments: boolean;
  readonly skipLine?: (trimmedLine: string, rawLine: string) => boolean;
  readonly oneViolationPerLine: boolean;
}

function processFile(opts: ProcessFileOptions): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const lines = opts.content.split('\n');
  for (const [i, line_] of lines.entries()) {
    const line = line_ ?? '';
    if (opts.skipComments && isCommentLine(line)) continue;
    if (opts.skipLine?.(line.trim(), line) === true) continue;
    processLine(line, i + 1, opts.patterns, opts.oneViolationPerLine, violations);
  }
  return violations;
}

function processLine(
  line: string,
  lineNum: number,
  patterns: readonly RegexListCheckPattern[],
  oneViolationPerLine: boolean,
  violations: CheckViolation[],
): void {
  let lineHasViolation = false;
  for (const pattern of patterns) {
    if (oneViolationPerLine && lineHasViolation) break;
    const pushed = matchPatternOnLine(pattern, line, lineNum, violations, oneViolationPerLine);
    if (pushed) lineHasViolation = true;
  }
}

/** Factory for the common "scan each line against a regex list" check pattern. */
export function defineRegexListCheck(config: DefineRegexListCheckConfig): Check {
  const skipComments = config.options?.skipCommentLines ?? true;
  const skipTests = config.options?.skipTestFiles ?? false;
  const skipFile = config.options?.skipFile;
  const skipLine = config.options?.skipLine;
  const oneViolationPerLine = config.options?.oneViolationPerLine ?? false;
  const patterns = config.patterns;

  return defineCheck({
    id: config.id,
    slug: config.slug,
    description: config.description,
    longDescription: config.longDescription,
    tags: config.tags,
    scope: config.scope,
    fileTypes: config.fileTypes,
    contentFilter: config.contentFilter,
    confidence: config.confidence,
    disabled: config.disabled,
    timeout: config.timeout,
    docs: config.docs,
    provider: config.provider,

    analyze(content: string, filePath: string): CheckViolation[] {
      if (skipTests && isTestFile(filePath)) return [];
      if (skipFile?.(filePath) === true) return [];
      return processFile({
        content,
        patterns,
        skipComments,
        skipLine,
        oneViolationPerLine,
      });
    },
  });
}
