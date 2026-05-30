/**
 * @fileoverview Body normalization + SHA-256 digest for Go.
 *
 * Extracted from `walk.ts` to keep that module focused on AST traversal
 * and occurrence construction. The body-digest defines the catalog's
 * `bodyHash` contract: walk produces it; resolve consumes it. Splitting
 * is safe because no other code under graph-go reaches into these
 * helpers — they are pure functions over source text.
 *
 * Normalization (consistent across language adapters):
 *
 *   1. Strip line + block comments (preserving string + rune literals
 *      so quoted comment-like text survives).
 *   2. Collapse runs of whitespace to a single space, trim.
 *   3. SHA-256.
 */

import { hashBody, normalizeWhitespace, type BodyDigest } from '@opensip-tools/graph';

export function digestGoBody(text: string): BodyDigest {
  return hashBody(normalizeWhitespace(stripGoComments(text)));
}

// Synthetic bodies (module-init) use the same normalization as real
// bodies; alias for self-documenting call sites.
export const digestSyntheticBody = digestGoBody;

/**
 * Strip Go line comments (// to end of line) and block comments
 * (slash-star ... star-slash). Go does NOT support nested block
 * comments. Preserve string literals (both interpreted `"…"` and raw
 * backtick `…`); preserve rune literals.
 */
function stripGoComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const next2 = text.slice(i, i + 2);
    if (next2 === '//') {
      i = skipToEndOfLine(text, i);
      continue;
    }
    if (next2 === '/*') {
      i = skipBlockComment(text, i + 2);
      continue;
    }
    const c = text[i];
    if (c === '"') {
      const block = consumeInterpretedString(text, i);
      out += block.text;
      i = block.index;
      continue;
    }
    if (c === '`') {
      const block = consumeRawString(text, i);
      out += block.text;
      i = block.index;
      continue;
    }
    if (c === "'") {
      const block = consumeRuneLiteral(text, i);
      out += block.text;
      i = block.index;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function skipToEndOfLine(text: string, start: number): number {
  let i = start;
  while (i < text.length && text[i] !== '\n') i++;
  return i;
}

function skipBlockComment(text: string, start: number): number {
  // Go block comments do NOT nest. Scan to the first `*/`.
  let i = start;
  while (i < text.length) {
    if (text.slice(i, i + 2) === '*/') return i + 2;
    i++;
  }
  /* v8 ignore next */
  return i;
}

function consumeInterpretedString(
  text: string,
  start: number,
): { readonly text: string; readonly index: number } {
  let i = start + 1;
  let buf = '"';
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      buf += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (text[i] === '"') {
      buf += '"';
      i++;
      break;
    }
    /* v8 ignore next */
    if (text[i] === '\n') break;
    buf += text[i];
    i++;
  }
  return { text: buf, index: i };
}

function consumeRawString(
  text: string,
  start: number,
): { readonly text: string; readonly index: number } {
  // Raw strings span across newlines and have no escape sequences.
  let i = start + 1;
  let buf = '`';
  while (i < text.length) {
    if (text[i] === '`') {
      buf += '`';
      i++;
      break;
    }
    buf += text[i];
    i++;
  }
  return { text: buf, index: i };
}

function consumeRuneLiteral(
  text: string,
  start: number,
): { readonly text: string; readonly index: number } {
  // A rune literal is a `'`, then either a single char or an escape
  // sequence (`\n`, `A`, `\xff`), then a closing `'`. Walk to the
  // next unescaped `'` within a small window.
  let i = start + 1;
  let buf = "'";
  let escape = false;
  while (i < text.length) {
    const c = text[i];
    if (escape) {
      buf += c;
      escape = false;
      i++;
      continue;
    }
    if (c === '\\') {
      buf += c;
      escape = true;
      i++;
      continue;
    }
    if (c === "'") {
      buf += c;
      i++;
      break;
    }
    /* v8 ignore next */
    if (c === '\n') break;
    buf += c;
    i++;
  }
  return { text: buf, index: i };
}
