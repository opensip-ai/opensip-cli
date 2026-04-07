/**
 * @fileoverview Shared utilities for stripping string literal and comment
 * content from source code. Used by fitness checks to avoid false positives
 * from patterns appearing inside string literals or comments.
 */

/**
 * Strip string literal contents from a single line.
 * Replaces content inside '...', "...", and `...` with empty strings.
 * Used by checks for per-line pattern matching to avoid false positives
 * from patterns appearing inside string literals.
 */
export function stripStringLiterals(line: string): string {
  return line
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/gs, '``')
}

/** Shared regex patterns for string literal replacement */
const SINGLE_QUOTE_RE = /'(?:[^'\\]|\\.)*'/g
const DOUBLE_QUOTE_RE = /"(?:[^"\\]|\\.)*"/g
const BACKTICK_RE = /`(?:[^`\\]|\\.)*`/gs

/**
 * Strip string literals and single-line comments from full file content.
 * Used by checks for quick-filter gates to avoid matching keywords
 * that only appear in documentation strings or comments.
 */
/**
 * Check if a position in a line is inside a string literal.
 * Scans characters before the match position for unescaped quotes/backticks.
 * Used by checks to avoid false positives from suggestion/description text.
 */
export function isInsideStringLiteral(line: string, matchIndex: number): boolean {
  let inSingle = false
  let inDouble = false
  let inTemplate = false
  let escaped = false

  for (let i = 0; i < matchIndex; i++) {
    const ch = line[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (ch === '\\' && (inSingle || inDouble || inTemplate)) {
      escaped = true
      continue
    }

    if (ch === "'" && !inDouble && !inTemplate) inSingle = !inSingle
    else if (ch === '"' && !inSingle && !inTemplate) inDouble = !inDouble
    else if (ch === '`' && !inSingle && !inDouble) inTemplate = !inTemplate
  }

  return inSingle || inDouble || inTemplate
}

/**
 * Strip string literals and single-line comments from full file content.
 * Used by checks for quick-filter gates to avoid matching keywords
 * that only appear in documentation strings or comments.
 */
export function stripStringsAndComments(content: string): string {
  // Strip string literals first
  let result = content
    .replace(SINGLE_QUOTE_RE, "''")
    .replace(DOUBLE_QUOTE_RE, '""')
    .replace(BACKTICK_RE, '``')
  // Strip single-line comments (after string stripping to avoid matching // inside strings)
  // eslint-disable-next-line sonarjs/slow-regex -- .*$ anchored to line end; linear scan
  result = result.replace(/\/\/.*$/gm, '')
  return result
}
