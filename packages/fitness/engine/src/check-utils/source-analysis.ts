/**
 * @fileoverview Source code analysis utilities
 *
 * Utilities for analyzing source code content.
 * These are generic helpers used across fitness checks for code analysis.
 */

/**
 * Options for isCommentLine detection
 */
export interface IsCommentLineOptions {
  /**
   * Include block comment start markers (/*) as comment lines
   * @default true
   */
  includeBlockStart?: boolean
}

/**
 * Check if a line of code is a comment line.
 *
 * Detects:
 * - Single-line comments: // ...
 * - Block comment continuation lines: * ...
 * - Optionally block comment start: /* ...
 *
 * @param line - The line of code to check
 * @param options - Detection options
 * @returns True if the line is a comment
 *
 * @example
 * isCommentLine('  // this is a comment') // true
 * isCommentLine('  * continuation line') // true
 * isCommentLine('  const x = 1;') // false
 * isCommentLine('  /* block start', { includeBlockStart: true }) // true
 */
export function isCommentLine(line: string, options: IsCommentLineOptions = {}): boolean {
  const { includeBlockStart = true } = options
  const trimmed = line.trim()

  // Single-line comment
  if (trimmed.startsWith('//')) {
    return true
  }

  // Block comment start (/* ...) — check before * continuation since /* starts with *
  if (trimmed.startsWith('/*')) {
    return includeBlockStart
  }

  // Block comment continuation (lines starting with * followed by space, /, or end-of-line)
  // Excludes operators like *= to avoid false positives
  if (trimmed.startsWith('*') && (trimmed.length === 1 || trimmed[1] === ' ' || trimmed[1] === '/' || trimmed[1] === '*')) {
    return true
  }

  return false
}
