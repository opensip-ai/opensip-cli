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

    // Block comment: /* ... */ — Go block comments do NOT nest
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

    // Raw string: `...` — no escapes, can span lines
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

    // Rune literal: '...' — preserve as code (don't strip)
    if (c === "'") {
      let j = i + 1
      let escape = false
      while (j < len) {
        if (escape) {
          escape = false
          j++
          continue
        }
        if (src[j] === '\\') {
          escape = true
          j++
          continue
        }
        if (src[j] === "'") {
          j++
          break
        }
        if (src[j] === '\n') break
        j++
      }
      i = j
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
