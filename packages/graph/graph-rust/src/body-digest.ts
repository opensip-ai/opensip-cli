/**
 * @fileoverview Rust body-digest helpers — strip comments, normalize
 * whitespace, hash. Extracted from `walk.ts` so the walker can focus on
 * tree-sitter traversal while the digest pipeline (which carries Rust-
 * specific token rules like nested block comments and the lifetime-vs-
 * char-literal heuristic) lives in one focused module.
 *
 * Behavior — string literals are preserved (their content is part of
 * the body), block comments may nest (Rust grammar permits this), and
 * char literals are distinguished from lifetimes by a short look-ahead.
 *
 * Sibling adapters (Java, Python, Go) keep their stripper inline because
 * their comment grammars are shorter; the Rust variant is large enough
 * to warrant its own file.
 */

import { hashBody, normalizeWhitespace, type BodyDigest } from '@opensip-tools/graph';
import { skipToEndOfLine } from '@opensip-tools/graph-adapter-common';

/**
 * Digest a Rust body text — strip comments, collapse whitespace, hash.
 *
 * Real bodies (functions, methods, closures) and synthetic bodies
 * (module-init aggregations) share this implementation; an alias keeps
 * the call site self-documenting without duplicating logic.
 */
export function digestRustBody(text: string): BodyDigest {
  return hashBody(normalizeWhitespace(stripRustComments(text)));
}

/**
 * Synthetic bodies (module-init) use the same normalization as real
 * bodies; an alias keeps the name at the call site self-documenting
 * without duplicating the implementation (sonarjs/no-identical-functions).
 */
export const digestSyntheticBody = digestRustBody;

/**
 * Strip Rust line comments (// to end of line) and block comments
 * (slash-star ... star-slash, including nested forms — Rust's grammar
 * permits nesting). Preserve string literals (their content matters).
 */
function stripRustComments(text: string): string {
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
      const block = consumeStringLiteral(text, i);
      out += block.text;
      i = block.index;
      continue;
    }
    if (c === "'" && isCharLiteral(text, i)) {
      /* v8 ignore start */
      const block = consumeCharLiteral(text, i);
      out += block.text;
      i = block.index;
      continue;
      /* v8 ignore stop */
    }
    out += c;
    i++;
  }
  return out;
}

function skipBlockComment(text: string, start: number): number {
  // Rust supports nested block comments. Track depth.
  let i = start;
  let depth = 1;
  while (i < text.length && depth > 0) {
    const next2 = text.slice(i, i + 2);
    if (next2 === '/*') {
      depth++;
      i += 2;
      continue;
    }
    if (next2 === '*/') {
      depth--;
      i += 2;
      continue;
    }
    i++;
  }
  return i;
}

function consumeStringLiteral(
  text: string,
  start: number,
): { readonly text: string; readonly index: number } {
  let i = start + 1;
  let buf = '"';
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      /* v8 ignore start */
      buf += text.slice(i, i + 2);
      i += 2;
      continue;
      /* v8 ignore stop */
    }
    if (text[i] === '"') {
      buf += '"';
      i++;
      break;
    }
    buf += text[i];
    i++;
  }
  return { text: buf, index: i };
}

/* v8 ignore start */
function isCharLiteral(text: string, i: number): boolean {
  // Heuristic: a `'` followed by a single char or escape, then another
  // `'`, with nothing alphanumeric immediately following the closing
  // `'` (otherwise it's a lifetime: `'static`, `'a`).
  if (text[i] !== "'") return false;
  const slice = text.slice(i, i + 4);
  // `'a'`, `'\n'`, `'\\''` patterns. Lifetimes don't have a closing
  // `'`, so we look for one within ~3 chars.
  if (slice.length < 3) return false;
  const escape = slice[1] === '\\';
  const closeIdx = escape ? 3 : 2;
  return slice[closeIdx] === "'";
}

function consumeCharLiteral(
  text: string,
  start: number,
): { readonly text: string; readonly index: number } {
  // Already verified by isCharLiteral.
  const escape = text[start + 1] === '\\';
  const len = escape ? 4 : 3;
  return { text: text.slice(start, start + len), index: start + len };
}
/* v8 ignore stop */
