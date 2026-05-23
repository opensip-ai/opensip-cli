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
    // Honor line splices: `\<newline>` continues the comment onto the next line.
    if (c === '/' && next === '/') {
      const start = i
      i += 2
      while (i < len) {
        if (src[i] === '\n') {
          if (src[i - 1] === '\\') { i++; continue }
          break
        }
        i++
      }
      commentRegions.push({ start, end: i })
      continue
    }

    // Block comment: /* ... */ (no nesting in C/C++)
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
        // Scan until unescaped closing ' or unescaped newline (unterminated).
        let j = startQuote + 1
        let escape = false
        while (j < len) {
          const ch = src[j]
          if (escape) { escape = false; j++; continue }
          if (ch === '\\') { escape = true; j++; continue }
          if (ch === "'") { j++; break }
          if (ch === '\n') { break }
          j++
        }
        i = j
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

/** Returns prefix length if src[i..] starts with a regular-string prefix (u8, u, U, L). 0 otherwise. */
function matchStringPrefix(src: string, i: number): number {
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
 */
function matchCharLiteralPrefix(src: string, i: number): number {
  if (src[i] === "'") return 0
  if (src[i] === 'u' && src[i + 1] === '8' && src[i + 2] === "'") return 2
  if ((src[i] === 'L' || src[i] === 'u' || src[i] === 'U') && src[i + 1] === "'") return 1
  return -1
}

export function stripStrings(content: string): string {
  const { stringRegions } = scan(content)
  return applyRegions(content, stringRegions)
}

export function stripComments(content: string): string {
  const { stringRegions, commentRegions } = scan(content)
  return applyRegions(content, [...stringRegions, ...commentRegions])
}
