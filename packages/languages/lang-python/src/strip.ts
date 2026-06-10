// Python string and comment stripping.
//
// Hand-written lexer that recognizes:
// - Line comments (# ... end-of-line)
// - Single-quoted strings ('...') and double-quoted strings ("...")
// - Triple-quoted strings ('''...''' and """...""") — multi-line
// - String prefixes (case-insensitive): r, b, u, f, rb, br, rf, fr
//   e.g. r'raw', b"bytes", f"hello {x}", rb'raw-bytes'
// - Raw strings (prefix r/rb/br/rf/fr): backslash is an ordinary
//   character EXCEPT before a quote (`\"` / `\'`), where it does NOT
//   terminate the literal — matches CPython's tokenizer rule
// - F-string expression interpolation is intentionally NOT preserved —
//   the entire body is treated as string content. This is a documented
//   MVP limitation; checks that need to see f-string expressions should
//   wait for tree-sitter integration.
//
// Both strip functions preserve byte length: replacement is whitespace
// (newlines preserved) so line/column positions remain stable.
//
// NOTE: this pack deliberately does NOT consume the C-family scanners
// from `@opensip-tools/core/languages/strip-utils.ts`
// (`scanRegularString`, `scanLineComment`, `scanBlockCommentNonNesting`,
// `scanCharLiteral`). Python's quote rules are the family outlier —
// strings open with either `'` or `"`, support eight ASCII prefix
// forms, and use `#` line comments — and the C-family helpers'
// signatures don't fit. If a second adopter (Ruby, Bash, Swift)
// appears, the right move is to lift a parameterized
// `scanQuotedString(quoteChar)` into core; with one consumer it stays
// here.

import { isIdentChar, makeStripper, type Region, type ScanResult } from '@opensip-tools/core';

// Allowed Python string prefixes (lowercase). Case-insensitivity is
// handled at match time by lowercasing the candidate. Two-letter
// combinations come first so a longer prefix wins over a shorter one.
const TWO_CHAR_PREFIXES = new Set(['rb', 'br', 'rf', 'fr']);
const ONE_CHAR_PREFIXES = new Set(['r', 'b', 'u', 'f']);

function isAsciiLetter(ch: string | undefined): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0) ?? 0;
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/**
 * If position `i` looks like the start of a Python string literal
 * (optionally with prefix), return the index of the opening quote.
 * Otherwise return null.
 *
 * The check is conservative: a prefix only counts if the character
 * BEFORE it isn't an identifier character, so identifiers like
 * `myvar = foo` or `bar` aren't mistaken for prefixes.
 *
 * Note: we deliberately do NOT distinguish raw from non-raw here.
 * For *tokenization-bound* (which is all the strip pass needs), the
 * two cases are identical: backslash always pairs with the next char.
 * The raw/non-raw distinction only matters for value extraction —
 * something the strip pass never does. See the scanner functions
 * for the CPython-spec citation.
 */
function matchStringStart(src: string, i: number): { quoteIndex: number } | null {
  const c = src[i];
  if (c === '"' || c === "'") {
    return { quoteIndex: i };
  }
  if (!isAsciiLetter(c)) return null;

  // Reject if the previous character is part of an identifier — then
  // this is the middle/end of an identifier, not a string prefix.
  if (i > 0 && isIdentChar(src[i - 1])) return null;

  // Try two-character prefix first.
  const c1 = src[i];
  const c2 = src[i + 1];
  if (c1 && c2) {
    const two = (c1 + c2).toLowerCase();
    if (TWO_CHAR_PREFIXES.has(two)) {
      const after = src[i + 2];
      if (after === '"' || after === "'") {
        return { quoteIndex: i + 2 };
      }
    }
  }

  // Single-character prefix.
  const one = c1?.toLowerCase();
  if (one && ONE_CHAR_PREFIXES.has(one)) {
    const after = src[i + 1];
    if (after === '"' || after === "'") {
      return { quoteIndex: i + 1 };
    }
  }

  return null;
}

interface StringScanResult {
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly next: number;
}

function scanTripleString(src: string, contentStart: number, quote: string): StringScanResult {
  const len = src.length;
  let i = contentStart;
  while (i < len) {
    const ch = src[i];
    if (ch === '\\') {
      // Backslash always pairs with the following character for
      // tokenization purposes, in BOTH non-raw and raw strings. In
      // non-raw, this is escape-sequence handling. In raw, escape
      // sequences are not interpreted, but per CPython:
      //   "Even in a raw literal, quotes can be escaped with a
      //    backslash, but the backslash remains in the result."
      // So `r"\""` is the 2-char string `\"`, terminated by the
      // third `"`. We must therefore skip past `\<anything>` in raw
      // mode too, otherwise the next quote is mis-read as terminator.
      // Newlines are preserved because we never replace them.
      i += 2;
      continue;
    }
    if (ch === quote && src[i + 1] === quote && src[i + 2] === quote) {
      return { contentStart, contentEnd: i, next: i + 3 };
    }
    i++;
  }
  // Unterminated — record what we have.
  return { contentStart, contentEnd: len, next: len };
}

function scanSingleString(src: string, contentStart: number, quote: string): StringScanResult {
  const len = src.length;
  let i = contentStart;
  while (i < len) {
    const ch = src[i];
    // Newline terminates a non-triple string in Python (it's a syntax
    // error to span lines without explicit continuation, but for
    // strip purposes treat newline as a terminator to avoid eating
    // the rest of the file on malformed input).
    if (ch === '\n') {
      return { contentStart, contentEnd: i, next: i };
    }
    if (ch === '\\') {
      // Backslash always pairs with the following character for
      // tokenization purposes, in BOTH non-raw and raw strings. In
      // non-raw, this is escape-sequence handling (and `\\\n` is line
      // continuation). In raw, escape sequences are not interpreted,
      // but per CPython:
      //   "Even in a raw literal, quotes can be escaped with a
      //    backslash, but the backslash remains in the result."
      // So `r"\""` is the 2-char string `\"`, terminated by the
      // third `"`. We must therefore skip past `\<anything>` in raw
      // mode too, otherwise the next quote is mis-read as terminator.
      i += 2;
      continue;
    }
    if (ch === quote) {
      return { contentStart, contentEnd: i, next: i + 1 };
    }
    i++;
  }
  return { contentStart, contentEnd: len, next: len };
}

function scan(src: string): ScanResult {
  const stringRegions: Region[] = [];
  const commentRegions: Region[] = [];
  const len = src.length;
  let i = 0;

  while (i < len) {
    const c = src[i];

    // Line comment: # ... \n
    if (c === '#') {
      const start = i;
      i++;
      while (i < len && src[i] !== '\n') i++;
      commentRegions.push({ start, end: i });
      continue;
    }

    // String literal (with optional prefix).
    const stringStart = matchStringStart(src, i);
    if (stringStart) {
      const { quoteIndex } = stringStart;
      const quote = src[quoteIndex];
      // Triple-quoted?
      if (src[quoteIndex + 1] === quote && src[quoteIndex + 2] === quote) {
        const contentStart = quoteIndex + 3;
        const result = scanTripleString(src, contentStart, quote);
        stringRegions.push({ start: result.contentStart, end: result.contentEnd });
        i = result.next;
      } else {
        const contentStart = quoteIndex + 1;
        const result = scanSingleString(src, contentStart, quote);
        stringRegions.push({ start: result.contentStart, end: result.contentEnd });
        i = result.next;
      }
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
