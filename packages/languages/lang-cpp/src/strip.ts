// C/C++ string and comment stripping.
//
// Recognizes:
// - Line comments (//) and block comments (NON-nesting)
// - Regular strings ("...") with backslash escapes
// - Raw strings (R"delim(...)delim", and prefixed forms u8R, uR, UR, LR)
// - Char literals ('a', '\n', preserved as code)

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
    if (c === "'" || (c === 'L' && next === "'") || (c === 'u' && next === "'") || (c === 'U' && next === "'")) {
      const startQuote = c === "'" ? i : i + 1
      // Look for matching '
      let j = startQuote + 1
      let escape = false
      const maxScan = Math.min(startQuote + 8, len)
      while (j < maxScan) {
        if (escape) { escape = false; j++; continue }
        if (src[j] === '\\') { escape = true; j++; continue }
        if (src[j] === "'") {
          i = j + 1
          break
        }
        j++
      }
      if (j >= maxScan) {
        i++
      }
      continue
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

export function stripStrings(content: string): string {
  const { stringRegions } = scan(content)
  return applyRegions(content, stringRegions)
}

export function stripComments(content: string): string {
  const { stringRegions, commentRegions } = scan(content)
  return applyRegions(content, [...stringRegions, ...commentRegions])
}
