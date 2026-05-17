// Python string and comment stripping.
//
// Hand-written lexer that recognizes:
// - Line comments (# ... end-of-line)
// - Single-quoted strings ('...') and double-quoted strings ("...")
// - Triple-quoted strings ('''...''' and """...""") — multi-line
// - String prefixes (case-insensitive): r, b, u, f, rb, br, rf, fr
//   e.g. r'raw', b"bytes", f"hello {x}", rb'raw-bytes'
// - Raw strings (prefix r/rb/br): backslash escapes are NOT honored
// - F-string expression interpolation is intentionally NOT preserved —
//   the entire body is treated as string content. This is a documented
//   MVP limitation; checks that need to see f-string expressions should
//   wait for tree-sitter integration.
//
// Both strip functions preserve byte length: replacement is whitespace
// (newlines preserved) so line/column positions remain stable.

import { applyRegions, type Region } from '@opensip-tools/core'

interface Scan {
  readonly stringRegions: Region[]
  readonly commentRegions: Region[]
}

// Allowed Python string prefixes (lowercase). Case-insensitivity is
// handled at match time by lowercasing the candidate. Two-letter
// combinations come first so a longer prefix wins over a shorter one.
const TWO_CHAR_PREFIXES = new Set(['rb', 'br', 'rf', 'fr'])
const ONE_CHAR_PREFIXES = new Set(['r', 'b', 'u', 'f'])

function isAsciiLetter(ch: string | undefined): boolean {
  if (!ch) return false
  const code = ch.codePointAt(0) ?? 0
  return (code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)
}

function isIdentChar(ch: string | undefined): boolean {
  if (!ch) return false
  const code = ch.codePointAt(0) ?? 0
  return (
    (code >= 0x41 && code <= 0x5A) ||
    (code >= 0x61 && code <= 0x7A) ||
    (code >= 0x30 && code <= 0x39) ||
    ch === '_'
  )
}

/**
 * If position `i` looks like the start of a Python string literal
 * (optionally with prefix), return the index of the opening quote and
 * whether the string is raw. Otherwise return null.
 *
 * The check is conservative: a prefix only counts if the character
 * BEFORE it isn't an identifier character, so identifiers like
 * `myvar = foo` or `bar` aren't mistaken for prefixes.
 */
function matchStringStart(
  src: string,
  i: number,
): { quoteIndex: number; isRaw: boolean } | null {
  const c = src[i]
  if (c === '"' || c === "'") {
    return { quoteIndex: i, isRaw: false }
  }
  if (!isAsciiLetter(c)) return null

  // Reject if the previous character is part of an identifier — then
  // this is the middle/end of an identifier, not a string prefix.
  if (i > 0 && isIdentChar(src[i - 1])) return null

  // Try two-character prefix first.
  const c1 = src[i]
  const c2 = src[i + 1]
  if (c1 && c2) {
    const two = (c1 + c2).toLowerCase()
    if (TWO_CHAR_PREFIXES.has(two)) {
      const after = src[i + 2]
      if (after === '"' || after === "'") {
        return { quoteIndex: i + 2, isRaw: two.includes('r') }
      }
    }
  }

  // Single-character prefix.
  const one = c1?.toLowerCase()
  if (one && ONE_CHAR_PREFIXES.has(one)) {
    const after = src[i + 1]
    if (after === '"' || after === "'") {
      return { quoteIndex: i + 1, isRaw: one === 'r' }
    }
  }

  return null
}

interface StringScanResult {
  readonly contentStart: number
  readonly contentEnd: number
  readonly next: number
}

function scanTripleString(
  src: string,
  contentStart: number,
  quote: string,
  isRaw: boolean,
): StringScanResult {
  const len = src.length
  let i = contentStart
  while (i < len) {
    const ch = src[i]
    if (!isRaw && ch === '\\') {
      // Escape consumes the next character (if present), preserving
      // newlines for line tracking.
      i += 2
      continue
    }
    if (ch === quote && src[i + 1] === quote && src[i + 2] === quote) {
      return { contentStart, contentEnd: i, next: i + 3 }
    }
    i++
  }
  // Unterminated — record what we have.
  return { contentStart, contentEnd: len, next: len }
}

function scanSingleString(
  src: string,
  contentStart: number,
  quote: string,
  isRaw: boolean,
): StringScanResult {
  const len = src.length
  let i = contentStart
  while (i < len) {
    const ch = src[i]
    // Newline terminates a non-triple string in Python (it's a syntax
    // error to span lines without explicit continuation, but for
    // strip purposes treat newline as a terminator to avoid eating
    // the rest of the file on malformed input).
    if (ch === '\n') {
      return { contentStart, contentEnd: i, next: i }
    }
    if (!isRaw && ch === '\\') {
      // Escape consumes the next character. \\\n (line continuation)
      // is fine — we just skip both chars.
      i += 2
      continue
    }
    if (ch === quote) {
      return { contentStart, contentEnd: i, next: i + 1 }
    }
    i++
  }
  return { contentStart, contentEnd: len, next: len }
}

function scan(src: string): Scan {
  const stringRegions: Region[] = []
  const commentRegions: Region[] = []
  const len = src.length
  let i = 0

  while (i < len) {
    const c = src[i]

    // Line comment: # ... \n
    if (c === '#') {
      const start = i
      i++
      while (i < len && src[i] !== '\n') i++
      commentRegions.push({ start, end: i })
      continue
    }

    // String literal (with optional prefix).
    const stringStart = matchStringStart(src, i)
    if (stringStart) {
      const { quoteIndex, isRaw } = stringStart
      const quote = src[quoteIndex]
      // Triple-quoted?
      if (src[quoteIndex + 1] === quote && src[quoteIndex + 2] === quote) {
        const contentStart = quoteIndex + 3
        const result = scanTripleString(src, contentStart, quote, isRaw)
        stringRegions.push({ start: result.contentStart, end: result.contentEnd })
        i = result.next
      } else {
        const contentStart = quoteIndex + 1
        const result = scanSingleString(src, contentStart, quote, isRaw)
        stringRegions.push({ start: result.contentStart, end: result.contentEnd })
        i = result.next
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
