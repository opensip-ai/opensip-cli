// Java string and comment stripping.
//
// Hand-written lexer that recognizes:
// - Line comments (//) and block comments (slash-star ... star-slash, non-nesting)
// - Regular strings ("...") with escape handling
// - Text blocks (""" ... """) — Java 13+ multi-line strings, opened by
//   `"""` followed by a line terminator and closed by `"""`
// - Char literals ('a', '\n') — preserved as-is (single character is code,
//   not a string)
//
// Both strip functions preserve byte length: replacement is whitespace
// (newlines preserved) so line/column positions remain stable.

import { applyRegions, scanRegularString, type Region } from '@opensip-tools/core'

interface Scan {
  readonly stringRegions: Region[]
  readonly commentRegions: Region[]
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- token-state-machine: cyclomatic complexity is inherent to lexer-style scanners; splitting hurts readability
function scan(src: string): Scan {
  const stringRegions: Region[] = []
  const commentRegions: Region[] = []
  const len = src.length
  let i = 0

  while (i < len) {
    const c = src[i]
    const next = src[i + 1]

    // Line comment: // ... \n
    if (c === '/' && next === '/') {
      const start = i
      i += 2
      while (i < len && src[i] !== '\n') i++
      commentRegions.push({ start, end: i })
      continue
    }

    // Block comment: /* ... */ (Java block comments do NOT nest)
    if (c === '/' && next === '*') {
      const start = i
      i += 2
      while (i < len) {
        if (src[i] === '*' && src[i + 1] === '/') {
          i += 2
          break
        }
        i++
      }
      commentRegions.push({ start, end: i })
      continue
    }

    // Text block: """ followed by line terminator, ... """
    // Per JLS, the opening delimiter is `"""` followed by optional
    // whitespace and then a line terminator. The body starts after that
    // terminator and ends at the next `"""`.
    if (c === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      // Look past optional whitespace for a newline to confirm text block
      let j = i + 3
      while (j < len && (src[j] === ' ' || src[j] === '\t')) j++
      if (j < len && (src[j] === '\n' || src[j] === '\r')) {
        // It's a text block. Body starts after the line terminator.
        // Skip the line terminator (handle \r\n).
        j += src[j] === '\r' && src[j + 1] === '\n' ? 2 : 1;
        const contentStart = j
        // Scan to closing """ — track backslash escapes so a literal `\"""`
        // inside the body does not prematurely close the text block (JLS §3.10.6
        // honors the same escape sequences as regular string literals).
        let bodyEscape = false
        let closed = false
        while (j < len) {
          if (bodyEscape) {
            bodyEscape = false
            j++
            continue
          }
          if (src[j] === '\\') {
            bodyEscape = true
            j++
            continue
          }
          if (src[j] === '"' && src[j + 1] === '"' && src[j + 2] === '"') {
            const contentEnd = j
            stringRegions.push({ start: contentStart, end: contentEnd })
            i = j + 3
            closed = true
            break
          }
          j++
        }
        if (!closed) {
          // Unterminated text block — record what we have
          stringRegions.push({ start: contentStart, end: len })
          i = len
        }
        continue
      }
      // Not a text block (e.g. `""` empty string followed by another `"`).
      // Fall through to regular string handling.
    }

    // Regular string: "..."
    if (c === '"') {
      const result = scanRegularString(src, i)
      stringRegions.push({ start: i + 1, end: result.contentEnd })
      i = result.next
      continue
    }

    // Char literal: '...' — preserve as code (single character, not a string).
    // Cap the scan at ~8 chars (matches lang-cpp / lang-rust) so a stray
    // apostrophe in malformed input cannot swallow lines of code looking for a
    // closer. A valid Java char literal is at most a single unicode escape
    // (e.g. `'A'` = 8 chars including quotes).
    //
    // NOTE: branch ordering is load-bearing — the `if (escape)` reset MUST
    // run before the `ch === "'"` closer check. For `'\''` (escaped
    // apostrophe — a common Java char literal), reordering would terminate
    // at the second `'` and miscompile the literal. lang-cpp uses the same
    // shape; see also F6 in the lang-java audit.
    if (c === "'") {
      const maxScan = Math.min(i + 8, len)
      let j = i + 1
      let escape = false
      let closed = false
      while (j < maxScan) {
        const ch = src[j]
        if (escape) {
          escape = false
          j++
          continue
        }
        if (ch === '\\') {
          escape = true
          j++
          continue
        }
        if (ch === "'") {
          j++
          closed = true
          break
        }
        if (ch === '\n') {
          // Unterminated — bail out at the newline
          break
        }
        j++
      }
      if (closed) {
        i = j
      } else {
        // Overflow / unterminated — treat the apostrophe as code rather than
        // committing the consumed run as a "char literal" that would mask any
        // strings or comments inside it.
        i++
      }
      continue
    }

    i++
  }

  return { stringRegions, commentRegions }
}

/** Replace string literal content with whitespace; preserves length. */
export function stripStrings(content: string): string {
  const { stringRegions } = scan(content)
  return applyRegions(content, stringRegions)
}

/** Replace string literals AND comments with whitespace; preserves length. */
export function stripComments(content: string): string {
  const { stringRegions, commentRegions } = scan(content)
  return applyRegions(content, [...stringRegions, ...commentRegions])
}
