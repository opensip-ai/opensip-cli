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

import {
  makeStripper,
  scanBlockCommentNonNesting,
  scanCharLiteral,
  scanLineComment,
  scanRegularString,
  type Region,
  type ScanResult,
} from '@opensip-cli/core';

// eslint-disable-next-line sonarjs/cognitive-complexity -- token-state-machine: cyclomatic complexity is inherent to lexer-style scanners; splitting hurts readability
function scan(src: string): ScanResult {
  const stringRegions: Region[] = [];
  const commentRegions: Region[] = [];
  const len = src.length;
  let i = 0;

  // INVARIANT: every iteration of the outer loop MUST advance `i`. Each
  // branch either (a) sets `i = result.end` / `i = result.next` from a
  // helper that always reports a strictly-increasing position, or
  // (b) falls through to the `i++` at the bottom. A future branch that
  // forgets to advance — or misuses `result.end` (note: scanCharLiteral
  // returns `start + 1` on overflow, which IS still an advance) — would
  // spin. Keep this invariant in mind when adding new token branches.
  while (i < len) {
    const c = src[i];
    const next = src[i + 1];

    // Line comment: // ... \n
    if (c === '/' && next === '/') {
      const start = i;
      const lc = scanLineComment(src, i);
      i = lc.end;
      commentRegions.push({ start, end: i });
      continue;
    }

    // Block comment: /* ... */ (Java block comments do NOT nest)
    if (c === '/' && next === '*') {
      const start = i;
      const bc = scanBlockCommentNonNesting(src, i);
      i = bc.end;
      commentRegions.push({ start, end: i });
      continue;
    }

    // Text block: """ followed by line terminator, ... """
    // Per JLS, the opening delimiter is `"""` followed by optional
    // whitespace and then a line terminator. The body starts after that
    // terminator and ends at the next `"""`.
    if (c === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      // Look past optional whitespace for a newline to confirm text block
      let j = i + 3;
      while (j < len && (src[j] === ' ' || src[j] === '\t')) j++;
      if (j < len && (src[j] === '\n' || src[j] === '\r')) {
        // It's a text block. Body starts after the line terminator.
        // Skip the line terminator (handle \r\n).
        j += src[j] === '\r' && src[j + 1] === '\n' ? 2 : 1;
        const contentStart = j;
        // Scan to closing """ — track backslash escapes so a literal `\"""`
        // inside the body does not prematurely close the text block (JLS §3.10.6
        // honors the same escape sequences as regular string literals).
        let bodyEscape = false;
        let closed = false;
        while (j < len) {
          if (bodyEscape) {
            bodyEscape = false;
            j++;
            continue;
          }
          if (src[j] === '\\') {
            bodyEscape = true;
            j++;
            continue;
          }
          if (src[j] === '"' && src[j + 1] === '"' && src[j + 2] === '"') {
            const contentEnd = j;
            stringRegions.push({ start: contentStart, end: contentEnd });
            i = j + 3;
            closed = true;
            break;
          }
          j++;
        }
        if (!closed) {
          // Unterminated text block — record what we have
          stringRegions.push({ start: contentStart, end: len });
          i = len;
        }
        continue;
      }
      // Not a text block (e.g. `""` empty string followed by another `"`).
      // Fall through to regular string handling.
    }

    // Regular string: "..."
    if (c === '"') {
      const result = scanRegularString(src, i);
      stringRegions.push({ start: i + 1, end: result.contentEnd });
      i = result.next;
      continue;
    }

    // Char literal: '...' — preserve as code (single character, not a string).
    // Use the shared scanCharLiteral helper from core (default 8-char cap
    // matches the lang-cpp / lang-rust heuristic; branch order is
    // load-bearing — see core's scanCharLiteral docstring and lang-java F6).
    if (c === "'") {
      const result = scanCharLiteral(src, i);
      i = result.end;
      continue;
    }

    i++;
  }

  return { stringRegions, commentRegions };
}

const stripper = makeStripper(scan);
/** Replace string literal content with whitespace; preserves length. */
export const stripStrings = stripper.stripStrings;
/** Replace string literals AND comments with whitespace; preserves length. */
export const stripComments = stripper.stripComments;
