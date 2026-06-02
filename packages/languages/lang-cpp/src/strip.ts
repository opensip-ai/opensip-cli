// C/C++ string and comment stripping.
//
// Recognizes:
// - Line comments (//) and block comments (NON-nesting)
// - Regular strings ("...") with backslash escapes
// - Raw strings (R"delim(...)delim", and prefixed forms u8R, uR, UR, LR)
// - Char literals ('a', '\n', u8'a', u'a', U'a', L'a', preserved as code)
// - Line splices in `//` line comments: a `\` immediately before `\n`
//   continues the comment onto the next physical line (per C/C++ phase 2
//   translation).
//
// NOTE: Broader preprocessor awareness (`#if 0` masking, macro splices in
// non-comment contexts, full phase-2 line-splicing across all token types)
// is intentionally OUT OF SCOPE for this strip primitive. We only honor
// `\<newline>` inside `//` line comments, which is the most common case
// where ignoring it produces visibly wrong output. See the lang-cpp
// architecture audit (F3, deferred items).

import {
  makeStripper,
  scanBlockCommentNonNesting,
  scanCharLiteral,
  scanLineComment,
  scanRegularString,
  type Region,
  type ScanResult,
} from '@opensip-tools/core'

// eslint-disable-next-line sonarjs/cognitive-complexity -- C++ has the largest token-set among the C-family packs (line/block comments, raw strings with optional encoding prefix, regular strings with optional encoding prefix, char literals with five opener forms); splitting the dispatch into per-token helpers would force shared mutable state across them and hurt readability. Suppression measured: 37/15 cognitive-complexity at this writing.
function scan(src: string): ScanResult {
  const stringRegions: Region[] = []
  const commentRegions: Region[] = []
  const len = src.length
  let i = 0

  while (i < len) {
    const c = src[i]
    const next = src[i + 1]

    // Line comment: // ... \n
    // Honor line splices: `\<newline>` continues the comment onto the next line.
    if (c === '/' && next === '/') {
      const start = i
      const lc = scanLineComment(src, i, { allowLineContinuation: true })
      i = lc.end
      commentRegions.push({ start, end: i })
      continue
    }

    // Block comment: /* ... */ (no nesting in C/C++)
    if (c === '/' && next === '*') {
      const start = i
      const bc = scanBlockCommentNonNesting(src, i)
      i = bc.end
      commentRegions.push({ start, end: i })
      continue
    }

    // Raw string with optional encoding prefix: R"d-char-seq(...)d-char-seq"
    // Prefixes: R, u8R, uR, UR, LR
    {
      const rawPrefixLen = matchRawStringPrefix(src, i)
      if (rawPrefixLen > 0) {
        // After the prefix should be R" then delimiter then (
        // Position immediately after prefix
        const afterPrefix = i + rawPrefixLen
        if (src[afterPrefix] === '"') {
          // Read d-char-seq up to (
          let j = afterPrefix + 1
          const delimStart = j
          while (j < len && src[j] !== '(' && src[j] !== '"') j++
          if (src[j] === '(') {
            const delim = src.slice(delimStart, j)
            const closingPattern = ')' + delim + '"'
            // content starts at j+1, ends at start of closingPattern
            const contentStart = j + 1
            const closeIdx = src.indexOf(closingPattern, contentStart)
            if (closeIdx === -1) {
              // Unterminated raw string — record what we have
              stringRegions.push({ start: contentStart, end: len })
              i = len
            } else {
              stringRegions.push({ start: contentStart, end: closeIdx })
              i = closeIdx + closingPattern.length
            }
            continue
          }
        }
        // Fall through — wasn't actually a raw string
      }
    }

    // Regular string with optional encoding prefix: u8"...", u"...", U"...", L"..."
    if (c === '"' || matchStringPrefix(src, i)) {
      const prefixLen = c === '"' ? 0 : matchStringPrefix(src, i)
      const quotePos = i + prefixLen
      if (src[quotePos] === '"') {
        const result = scanRegularString(src, quotePos)
        stringRegions.push({ start: quotePos + 1, end: result.contentEnd })
        i = result.next
        continue
      }
    }

    // Char literal: '...' — preserve (don't strip)
    // Openers: ', L', u', U', u8' (C++17). Order matters: u8' must be
    // checked before u' since 'u8' is a 2-char prefix.
    {
      const charPrefixLen = matchCharLiteralPrefix(src, i)
      if (charPrefixLen >= 0) {
        const startQuote = i + charPrefixLen
        // Scan the body from the opening apostrophe via the shared helper.
        // Use a generous cap (12) so unicode escapes like '\u{1F600}'
        // (10 chars including quotes) close cleanly. Branch order is
        // load-bearing — see core's scanCharLiteral docstring.
        // Scan past the literal (or, on overflow/unterminated, past the
        // opening apostrophe so we don't loop). The shared helper returns
        // `start + 1` on overflow — that's already the bail-out we want
        // when no closing quote is found within the cap.
        const result = scanCharLiteral(src, startQuote, { maxScan: 12 })
        i = result.end
        continue
      }
    }

    i++
  }

  return { stringRegions, commentRegions }
}

/** Returns prefix length if src[i..] starts with a raw-string prefix (R, u8R, uR, UR, LR). 0 otherwise. */
function matchRawStringPrefix(src: string, i: number): number {
  if (src[i] === 'R') return 1
  if (src[i] === 'u' && src[i + 1] === '8' && src[i + 2] === 'R') return 3
  if ((src[i] === 'u' || src[i] === 'U' || src[i] === 'L') && src[i + 1] === 'R') return 2
  return 0
}

/**
 * Identifier-character predicate for prefix-anchor guards. C/C++
 * identifiers are `[A-Za-z0-9_]+`; if `prev` is one of those, then the
 * candidate "prefix" character is actually the middle/end of an
 * identifier (e.g. `abcL"foo"` — `L` is not a string prefix here), so
 * the prefix matchers must reject.
 */
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
 * Returns prefix length if src[i..] starts with a regular-string prefix
 * (u8, u, U, L). 0 otherwise.
 *
 * Anchored against identifier boundaries: a candidate prefix only counts
 * if the character before `i` is not an identifier character (lang-cpp
 * F12). Without this anchor, source like `abcL"foo"` would get the `L"`
 * mis-recognized as a wide-string opener mid-identifier.
 */
function matchStringPrefix(src: string, i: number): number {
  if (i > 0 && isIdentChar(src[i - 1])) return 0
  if (src[i] === 'u' && src[i + 1] === '8') return 2
  if (src[i] === 'u' || src[i] === 'U' || src[i] === 'L') return 1
  return 0
}

/**
 * Returns the length of the char-literal opener prefix at src[i..] (i.e. the
 * number of chars before the opening `'`), or -1 if there is no char-literal
 * opener at this position.
 *
 * Recognized openers: `'` (0), `L'` / `u'` / `U'` (1), `u8'` (2).
 * Order matters: u8' must be checked before u'.
 *
 * Anchored against identifier boundaries (lang-cpp F12): a non-bare
 * apostrophe candidate (i.e. one preceded by `L`/`u`/`U`/`u8`) only
 * counts if the character before `i` is not an identifier character.
 * The bare-apostrophe case (`src[i] === "'"`) is unaffected — `'` is
 * never an identifier character.
 */
function matchCharLiteralPrefix(src: string, i: number): number {
  if (src[i] === "'") return 0
  if (i > 0 && isIdentChar(src[i - 1])) return -1
  if (src[i] === 'u' && src[i + 1] === '8' && src[i + 2] === "'") return 2
  if ((src[i] === 'L' || src[i] === 'u' || src[i] === 'U') && src[i + 1] === "'") return 1
  return -1
}

const stripper = makeStripper(scan)
/** Returns C/C++ source with every string-literal region blanked out. */
export const stripStrings = stripper.stripStrings
/** Returns C/C++ source with every string-literal AND comment region blanked out. */
export const stripComments = stripper.stripComments
