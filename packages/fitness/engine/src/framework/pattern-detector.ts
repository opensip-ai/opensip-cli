// @fitness-ignore-file semgrep-scan -- reviewed: pattern justified for this module
// @fitness-ignore-file async-waterfall-detection -- sequential async operations are intentional for ordered execution
/**
 * @fileoverview PatternDetector - Strategy pattern for code pattern detection
 *
 * Provides regex-based pattern detection in source files with
 * position tracking, comment awareness, and Signal generation.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { createSignal } from '@opensip-tools/core'

import { mapFindingSeverity, mapTagsToSignalCategory } from './severity-mapping.js'

import type { FindingSeverity } from '../types/findings.js'
import type { Signal } from '@opensip-tools/core'

// =============================================================================
// PATTERN DEFINITION
// =============================================================================

/**
 * A pattern definition for detection.
 * Users provide these to configure the detector.
 */
export interface PatternDefinition {
  /** Unique pattern identifier */
  readonly id: string
  /** Regex pattern to match */
  readonly regex: RegExp
  /** Human-readable message */
  readonly message: string
  /** Severity level */
  readonly severity: FindingSeverity
  /** Suggestion for fixing */
  readonly suggestion?: string
  /** Whether to skip matches inside comments */
  readonly skipInComments?: boolean
  /** Canonical implementation ID (for grouping) */
  readonly canonical?: string
}

// =============================================================================
// TYPES
// =============================================================================

/**
 * A single pattern match in a file.
 */
export interface PatternMatch {
  readonly pattern: PatternDefinition
  readonly line: number
  readonly column: number
  readonly match: string
  readonly lineContent: string
}

/**
 * Options for pattern detection.
 */
export interface DetectorOptions {
  readonly checkId: string
  readonly checkSlug: string
  readonly cwd: string
  readonly applySeverityRules?: boolean | undefined
  readonly checkTags?: readonly string[] | undefined
  readonly provider?: string | undefined
}

/**
 * Result of pattern detection on a single file.
 */
export interface FileDetectionResult {
  readonly filePath: string
  readonly file: string
  readonly matches: readonly PatternMatch[]
  readonly signals: readonly Signal[]
}

// =============================================================================
// DETECTOR
// =============================================================================

/**
 * Detect patterns in code content.
 *
 * @example
 * ```typescript
 * const detector = PatternDetector.fromDefinitions([
 *   { id: 'console-log', regex: /console\.log/g, message: 'No console.log', severity: 'warning' }
 * ]);
 * const result = detector.detect(content, filePath, { checkId: 'my-check', checkSlug: 'my-check', cwd: '/repo' });
 * ```
 */
export class PatternDetector {
  private readonly patterns: readonly PatternDefinition[]

  private constructor(patterns: readonly PatternDefinition[]) {
    this.patterns = patterns
  }

  /**
   * Create a detector from raw pattern definitions.
   */
  static fromDefinitions(patterns: readonly PatternDefinition[]): PatternDetector {
    if (!Array.isArray(patterns)) return new PatternDetector([])
    return new PatternDetector(patterns)
  }

  /**
   * Detect patterns in file content.
   */
  detect(content: string, filePath: string, options: DetectorOptions): FileDetectionResult {
    const file = path.relative(options.cwd, filePath)
    const lines = content.split('\n')
    const matches: PatternMatch[] = []

    for (const pattern of this.patterns) {
      const patternMatches = this.findMatches(content, lines, pattern)
      for (const patternMatch of patternMatches) {
        matches.push(patternMatch)
      }
    }

    const signals = matches.map((match) =>
      this.matchToSignal(match, filePath, options),
    )

    return { filePath, file, matches, signals }
  }

  private findMatches(
    content: string,
    lines: string[],
    pattern: PatternDefinition,
  ): PatternMatch[] {
    if (!Array.isArray(lines)) return []

    const matches: PatternMatch[] = []
    // Clone the regex to reset lastIndex for concurrent detection calls
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags)
    const lineOffsets = this.computeLineOffsets(content)

    let match: RegExpExecArray | null
    while ((match = regex.exec(content)) !== null) {
      const { line, column } = this.getPositionFromOffsets(lineOffsets, match.index)
      const lineContent = lines[line - 1] ?? ''

      if (pattern.skipInComments && this.isInComment(lineContent, column - 1)) {
        continue
      }

      matches.push({ pattern, line, column, match: match[0], lineContent })

      if (match[0].length === 0) {
        regex.lastIndex++
      }
    }

    return matches
  }

  /** Pre-compute the start offset of each line for O(1) position lookups via binary search. */
  private computeLineOffsets(content: string): number[] {
    const offsets = [0]
    // eslint-disable-next-line unicorn/no-for-loop -- offset-bearing scan: captures UTF-16 line starts
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '\n') {
        offsets.push(i + 1)
      }
    }
    return offsets
  }

  /** Binary search through pre-computed line offsets to find line/column for a character index. */
  private getPositionFromOffsets(offsets: number[], index: number): { line: number; column: number } {
    // @fitness-ignore-next-line clean-code-naming-quality -- lo/hi are standard binary search variable names
    let lo = 0
    let hi = offsets.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1
       
      if (offsets[mid] <= index) {
        lo = mid
      } else {
        hi = mid - 1
      }
    }
     
    return { line: lo + 1, column: index - offsets[lo] + 1 }
  }

  private isInComment(lineContent: string, column: number): boolean {
    const singleLineComment = lineContent.indexOf('//')
    if (singleLineComment !== -1 && singleLineComment < column) return true

    const blockCommentStart = lineContent.indexOf('/*')
    if (blockCommentStart !== -1 && blockCommentStart < column) {
      const blockCommentEnd = lineContent.indexOf('*/')
      if (blockCommentEnd === -1 || blockCommentEnd > column) return true
    }

    const trimmed = lineContent.trimStart()
    if (trimmed.startsWith('*') && !trimmed.startsWith('*/')) return true

    return false
  }

  private matchToSignal(
    match: PatternMatch,
    filePath: string,
    options: DetectorOptions,
  ): Signal {
    return createSignal({
      source: 'fitness',
      provider: options.provider ?? 'opensip',
      severity: mapFindingSeverity(match.pattern.severity),
      category: mapTagsToSignalCategory(options.checkTags ?? []),
      ruleId: `fit:${options.checkSlug}`,
      message: match.pattern.message,
      suggestion: match.pattern.suggestion,
      code: { file: filePath, line: match.line, column: match.column },
      fix: match.pattern.suggestion ? { action: 'refactor', confidence: 0.5 } : undefined,
      metadata: {
        match: match.match,
        patternId: match.pattern.id,
        codeSnippet: match.lineContent.trim(),
      },
    })
  }

  get configuredPatterns(): readonly PatternDefinition[] {
    return this.patterns
  }
}

/**
 * Helper to run detection on multiple files.
 */
export async function detectInFiles(
  detector: PatternDetector,
  files: readonly string[],
  readFile: (path: string) => Promise<string>,
  options: DetectorOptions,
): Promise<readonly FileDetectionResult[]> {
  // @fitness-ignore-next-line no-unbounded-concurrency -- file count bounded by caller; individual reads are lightweight
  const results = await Promise.all(
    files.map(async (filePath) => {
      try {
        const fileStats = await fs.stat(filePath)
        if (fileStats.size > 10_000_000) return null
        const content = await readFile(filePath)
        return detector.detect(content, filePath, options)
      } catch {
        // @swallow-ok Skip files that can't be read gracefully
        return null
      }
    }),
  )

  return results.filter((result): result is FileDetectionResult => result !== null)
}
