// Go string and comment stripping.
//
// Hand-written lexer that recognizes:
// - Line comments (//) and block comments (slash-star ... star-slash) — Go block comments do NOT nest
// - Interpreted strings ("...") with escape handling
// - Raw strings (backtick ... backtick) — no escape processing, can span lines
// - Rune literals ('a', '\n') — preserved as code (not stripped)
//
// Both strip functions preserve byte length: replacement is whitespace
// (newlines preserved) so line/column positions remain stable.

import {
  makeStripper,
  scanBlockCommentNonNesting,
  scanCharLiteral,
  scanLineComment,
  scanRegularString,
  type Region,
  type ScanResult,
} from '@opensip-tools/core'

// eslint-disable-next-line sonarjs/cognitive-complexity -- token-state-machine: cyclomatic complexity is inherent to lexer-style scanners; splitting hurts readability
function scan(src: string): ScanResult {
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
      const lc = scanLineComment(src, i)
      i = lc.end
      commentRegions.push({ start, end: i })
      continue
    }

    // Block comment: /* ... */ — Go block comments do NOT nest
    if (c === '/' && next === '*') {
      const start = i
      const bc = scanBlockCommentNonNesting(src, i)
      i = bc.end
      commentRegions.push({ start, end: i })
      continue
    }

    // Raw string: `...` — no escapes, can span lines.
    //
    // @todo Per the Go spec, carriage returns (\r) inside raw strings are
    // discarded from the string value (see go/spec#raw_string_lit). We do
    // not represent that here because the strip pass is region-bound, not
    // value-extraction; a future `findStringLiterals` query API will need
    // to apply the \r-discard rule when materializing literal values.
    if (c === '`') {
      const contentStart = i + 1
      let j = i + 1
      while (j < len && src[j] !== '`') j++
      stringRegions.push({ start: contentStart, end: j })
      i = j < len ? j + 1 : len
      continue
    }

    // Interpreted string: "..." with \ escapes
    if (c === '"') {
      const result = scanRegularString(src, i)
      stringRegions.push({ start: i + 1, end: result.contentEnd })
      i = result.next
      continue
    }

    // Rune literal: '...' — preserve as code (don't strip).
    // Go runes have no fixed cap analogous to lang-java/lang-cpp; use a
    // generous cap (12) to accommodate the longest valid form
    // ('\U0001F600' = 12 chars including quotes). The shared helper's
    // load-bearing branch order (escape before close-quote) is the same
    // shape Go's previous inline scanner used.
    if (c === "'") {
      const result = scanCharLiteral(src, i, { maxScan: 12 })
      i = result.end
      continue
    }

    i++
  }

  return { stringRegions, commentRegions }
}

const stripper = makeStripper(scan)
/** Replace string literal content with whitespace; preserves length. */
export const stripStrings = stripper.stripStrings
/** Replace string literals AND comments with whitespace; preserves length. */
export const stripComments = stripper.stripComments
