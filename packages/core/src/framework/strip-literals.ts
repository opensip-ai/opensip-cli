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

/**
 * Strip strings, single-line comments, AND block comments while preserving
 * BOTH character positions and line numbers. Each stripped character is
 * replaced with a space (non-newline) so the output has identical length
 * and line offsets to the input. Use this when downstream processing
 * needs to map a match index back to a line number in the ORIGINAL
 * source — `stripStringsAndComments` collapses string literals to empty
 * pairs, which shifts indexes and breaks `getLineNumber(content, idx)`.
 *
 * Strips:
 * - Single-quoted, double-quoted, and template-literal string contents
 * - Single-line `// ...` comments (to end of line)
 * - Block `/* ... *\/` comments (including JSDoc `/** ... *\/`)
 *
 * Preserves: newlines, total character count, character positions of
 * code OUTSIDE these regions.
 */
export function stripStringsAndCommentsPreservingPositions(content: string): string {
  const out: string[] = []
  let i = 0
  let inSingle = false
  let inDouble = false
  let inTemplate = false
  let inLineComment = false
  let inBlockComment = false
  let escaped = false

  while (i < content.length) {
    const ch = content[i] as string
    const next = content[i + 1]

    // Inside any string: blank out chars (preserve newlines) until terminator.
    if (inSingle || inDouble || inTemplate) {
      if (escaped) {
        out.push(ch === '\n' ? '\n' : ' ')
        escaped = false
        i++
        continue
      }
      if (ch === '\\') {
        out.push(' ')
        escaped = true
        i++
        continue
      }
      if ((ch === "'" && inSingle) || (ch === '"' && inDouble) || (ch === '`' && inTemplate)) {
        // Keep terminator for symmetry — replace with space too. The
        // string itself is gone; outer code doesn't care about the quote.
        out.push(' ')
        inSingle = inDouble = inTemplate = false
        i++
        continue
      }
      out.push(ch === '\n' ? '\n' : ' ')
      i++
      continue
    }

    // Inside line comment: blank to end of line.
    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false
        out.push('\n')
      } else {
        out.push(' ')
      }
      i++
      continue
    }

    // Inside block comment: blank until `*/`.
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        out.push('  ')
        inBlockComment = false
        i += 2
        continue
      }
      out.push(ch === '\n' ? '\n' : ' ')
      i++
      continue
    }

    // Outside any region: detect openers.
    if (ch === '/' && next === '/') {
      out.push('  ')
      inLineComment = true
      i += 2
      continue
    }
    if (ch === '/' && next === '*') {
      out.push('  ')
      inBlockComment = true
      i += 2
      continue
    }
    if (ch === "'") {
      out.push(' ')
      inSingle = true
      i++
      continue
    }
    if (ch === '"') {
      out.push(' ')
      inDouble = true
      i++
      continue
    }
    if (ch === '`') {
      out.push(' ')
      inTemplate = true
      i++
      continue
    }

    out.push(ch)
    i++
  }

  return out.join('')
}
