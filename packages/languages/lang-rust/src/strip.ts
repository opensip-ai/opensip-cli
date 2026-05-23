// Rust string and comment stripping.
//
// Hand-written lexer that recognizes:
// - Line comments (//) and nested block comments (slash-star ... star-slash)
// - Regular strings ("...") with escape handling — Rust regular strings
//   may span multiple lines (unlike Java/Go/C++), so we pass
//   `allowMultiline: true` to core's shared scanner.
// - Raw strings (r"...", r#"..."#, ..., r####"..."####)
// - Byte strings (b"...") and byte-raw strings (br#"..."#) — note that
//   byte-string content is treated as opaque bytes; this layer does NOT
//   enforce the ASCII-only / valid-escape rules of `b"..."`. A future
//   check that wants to flag invalid byte literals will have to layer
//   that validation on top of the region scan.
// - Char literals ('a', '\n', '\u{1234}') — preserved as-is, with the
//   lifetime-vs-literal disambiguation done at the call site here.
//
// Both strip functions preserve byte length: replacement is whitespace
// (newlines preserved) so line/column positions remain stable.

import {
  applyRegions,
  scanBlockCommentNesting,
  scanLineComment,
  scanRegularString,
  type Region,
} from '@opensip-tools/core'

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
      const lc = scanLineComment(src, i)
      i = lc.end
      commentRegions.push({ start, end: i })
      continue
    }

    // Block comment: /* ... */ with nesting
    if (c === '/' && next === '*') {
      const start = i
      const bc = scanBlockCommentNesting(src, i)
      i = bc.end
      commentRegions.push({ start, end: i })
      continue
    }

    // Raw string: r"..." or r#"..."# or r##"..."## (any number of #)
    // Byte-raw string: br"..." or br#"..."#
    if (
      (c === 'r' && (next === '"' || next === '#')) ||
      (c === 'b' && src[i + 1] === 'r' && (src[i + 2] === '"' || src[i + 2] === '#'))
    ) {
      const prefixLen = c === 'b' ? 2 : 1 // br vs r
      let j = i + prefixLen
      let hashes = 0
      while (j < len && src[j] === '#') {
        hashes++
        j++
      }
      if (j < len && src[j] === '"') {
        const contentStart = j + 1
        j++
        // Find closing " followed by `hashes` # characters
        while (j < len) {
          if (src[j] === '"') {
            let k = 0
            while (k < hashes && src[j + 1 + k] === '#') k++
            if (k === hashes) {
              const contentEnd = j
              stringRegions.push({ start: contentStart, end: contentEnd })
              j += 1 + hashes
              i = j
              break
            }
          }
          j++
        }
        if (j >= len) {
          // Unterminated raw string — record what we have
          stringRegions.push({ start: contentStart, end: len })
          i = len
        }
        continue
      }
      // Not actually a raw string (e.g. `r` is just an identifier)
      i++
      continue
    }

    // Byte string: b"..." — Rust strings may span multiple lines.
    if (c === 'b' && next === '"') {
      i++
      const result = scanRegularString(src, i, { allowMultiline: true })
      stringRegions.push({ start: i + 1, end: result.contentEnd })
      i = result.next
      continue
    }

    // Regular string: "..." — Rust strings may span multiple lines.
    if (c === '"') {
      const result = scanRegularString(src, i, { allowMultiline: true })
      stringRegions.push({ start: i + 1, end: result.contentEnd })
      i = result.next
      continue
    }

    // Char literal: '...' — skip without recording (char literals are single chars)
    // Use a heuristic: if we see ' followed by content that closes within ~6 chars, treat as char.
    // Otherwise it's a lifetime annotation ('a, 'static, etc.).
    if (c === "'") {
      // Lifetime: 'identifier (no closing quote)
      const after = src[i + 1]
      if (after === undefined) {
        i++
        continue
      }
      // Look ahead to see if there's a closing quote within ~8 chars.
      // (Same heuristic the previous inline scanner used.) Core's
      // scanCharLiteral helper *does* distinguish overflow from success
      // (overflow returns `end === start + 1`, success returns
      // `end > start + 1`), so a migration to that helper with a
      // `result.end === i + 1` lifetime branch is feasible. We keep
      // this look-ahead inline because it makes the lifetime branch
      // decision local to the lexer state machine and the explicit
      // `escape`/`foundClose` variables are easier to follow for the
      // Rust-specific edge cases the test suite exercises.
      const maxScan = Math.min(i + 8, len)
      let foundClose = -1
      let escape = false
      for (let k = i + 1; k < maxScan; k++) {
        if (escape) {
          escape = false
          continue
        }
        if (src[k] === '\\') {
          escape = true
          continue
        }
        if (src[k] === "'") {
          foundClose = k
          break
        }
      }
      if (foundClose >= 0) {
        // Char literal — preserve as code (don't strip)
        i = foundClose + 1
      } else {
        // Lifetime — skip the apostrophe and continue
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
