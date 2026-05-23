/**
 * @fileoverview defineRegexListCheck - Template helper for regex-list scanners.
 *
 * Wraps {@link defineCheck} for the common "for line; for pattern; emit one
 * violation per match" shape that ~13 sites in @opensip-tools/checks-universal
 * (and a handful in @opensip-tools/checks-typescript) reimplement, often with
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

import { isCommentLine } from '../check-utils/source-analysis.js'
import { isTestFile } from '../check-utils/test-helpers.js'

import { defineCheck } from './define-check.js'

import type { CheckScope, CheckViolation } from './check-config.js'
import type { Check } from './check-types.js'

/**
 * A single regex pattern entry consumed by {@link defineRegexListCheck}.
 *
 * Each entry has a stable UUID `id` and a kebab-case `slug` so the pattern
 * is individually addressable for documentation and developer tooling. The
 * `slug` is emitted on every produced violation as `type: pattern.slug`.
 */
export interface RegexListCheckPattern {
  /** Stable UUID identifying this pattern. Purely descriptive. */
  readonly id: string
  /** Kebab-case slug for this pattern (e.g. `'console-log'`). Emitted as `type` on each violation. */
  readonly slug: string
  /** Regex executed against each (non-skipped) line. Global flag is recommended for multi-match-per-line behaviour. */
  readonly regex: RegExp
  /** Violation message reported on a match. */
  readonly message: string
  /** Optional suggestion text for the violation. */
  readonly suggestion?: string
  /**
   * Per-pattern severity. Defaults to `'warning'`. Pattern-level severity
   * is preferred over a per-check default because most adopters mix
   * error-class and warning-class patterns inside the same regex list.
   */
  readonly severity?: 'error' | 'warning'
}

/**
 * Options governing line iteration in {@link defineRegexListCheck}.
 */
export interface RegexListCheckOptions {
  /**
   * Skip lines that {@link isCommentLine} reports as comments.
   * Default: `true`.
   */
  readonly skipCommentLines?: boolean
  /**
   * Skip files that {@link isTestFile} reports as test files. Useful for
   * checks that should not run against `*.test.ts` / `*.spec.ts` /
   * `__tests__/` paths.
   * Default: `false`.
   */
  readonly skipTestFiles?: boolean
}

/**
 * Configuration accepted by {@link defineRegexListCheck}.
 *
 * The fields above `patterns` mirror {@link defineCheck}'s analyze-mode
 * `BaseCheckConfig`. The `analyze` function is synthesised by this helper.
 */
export interface DefineRegexListCheckConfig {
  readonly id: string
  readonly slug: string
  readonly description: string
  readonly longDescription?: string
  readonly tags: readonly string[]
  readonly scope?: CheckScope
  readonly fileTypes?: readonly string[]
  readonly contentFilter?: 'raw' | 'strip-strings' | 'strip-strings-and-comments'
  readonly confidence?: 'high' | 'medium' | 'low'
  readonly disabled?: boolean
  readonly timeout?: number
  readonly docs?: string
  readonly provider?: string
  /** The list of regex patterns to scan each line against. */
  readonly patterns: readonly RegexListCheckPattern[]
  /** Line- and file-level skip toggles. */
  readonly options?: RegexListCheckOptions
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
 * @throws {ValidationError} via {@link defineCheck} when the synthesised
 *   config is invalid.
 */
export function defineRegexListCheck(config: DefineRegexListCheckConfig): Check {
  const skipComments = config.options?.skipCommentLines ?? true
  const skipTests = config.options?.skipTestFiles ?? false
  const patterns = config.patterns

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
      if (skipTests && isTestFile(filePath)) return []

      const violations: CheckViolation[] = []
      const lines = content.split('\n')

      for (const [i, line_] of lines.entries()) {
        const line = line_ ?? ''
        if (skipComments && isCommentLine(line)) continue

        const lineNum = i + 1
        for (const pattern of patterns) {
          // Reset lastIndex — pattern objects are reused across lines
          // and files; failing to reset would skip matches at low
          // positions on subsequent calls.
          pattern.regex.lastIndex = 0

          // exec-loop emits one violation per match for global regexes;
          // for non-global regexes, exec always starts at position 0
          // so the loop runs at most once.
          let match = pattern.regex.exec(line)
          while (match !== null) {
            violations.push({
              line: lineNum,
              column: match.index,
              message: pattern.message,
              severity: pattern.severity ?? 'warning',
              suggestion: pattern.suggestion,
              match: match[0],
              type: pattern.slug,
            })
            // Non-global regex: stop after the first match. Otherwise
            // exec would loop forever (lastIndex stays at 0).
            if (!pattern.regex.global) break
            match = pattern.regex.exec(line)
          }
        }
      }

      return violations
    },
  })
}
