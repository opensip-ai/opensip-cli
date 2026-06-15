/**
 * @fileoverview Body normalization + SHA-256 digest for Java.
 *
 * Extracted from `walk.ts` to keep that module focused on AST traversal
 * and occurrence construction. The body-digest defines the catalog's
 * `bodyHash` contract: walk produces it; resolve consumes it.
 *
 * Normalization (consistent across language adapters):
 *
 *   1. Strip `//` line and `/* … *\/` block comments (Javadoc included
 *      — same scanner). Preserve string + text block + char literals so
 *      quoted comment-like text survives.
 *   2. Collapse runs of whitespace to a single space, trim.
 *   3. SHA-256.
 */

import { hashBody, normalizeWhitespace, type BodyDigest } from '@opensip-cli/graph';
import { skipBlockComment, skipToEndOfLine } from '@opensip-cli/graph-adapter-common';

export function digestJavaBody(text: string): BodyDigest {
  return hashBody(normalizeWhitespace(stripJavaComments(text)));
}

export const digestSyntheticBody = digestJavaBody;

/**
 * Strip Java `//` line comments and `/* … *\/` block comments (which
 * include Javadoc `/** … *\/` — same scanner). Java block comments do
 * NOT nest. Preserve string literals (regular `"…"` and text blocks
 * `"""…"""`) and char literals.
 */
function stripJavaComments(text: string): string {
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
    // Text block: `"""…"""`. Must check before regular `"` because the
    // opening triple-quote starts with `"`.
    if (text.slice(i, i + 3) === '"""') {
      const block = consumeTextBlock(text, i);
      out += block.text;
      i = block.index;
      continue;
    }
    const c = text[i];
    if (c === '"') {
      const block = consumeStringLiteral(text, i);
      out += block.text;
      i = block.index;
      continue;
    }
    if (c === "'") {
      const block = consumeCharLiteral(text, i);
      out += block.text;
      i = block.index;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function consumeStringLiteral(
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

function consumeTextBlock(
  text: string,
  start: number,
): { readonly text: string; readonly index: number } {
  // Text blocks span newlines and end at the next un-escaped `"""`.
  let i = start + 3;
  let buf = '"""';
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      buf += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (text.slice(i, i + 3) === '"""') {
      buf += '"""';
      i += 3;
      break;
    }
    buf += text[i];
    i++;
  }
  return { text: buf, index: i };
}

function consumeCharLiteral(
  text: string,
  start: number,
): { readonly text: string; readonly index: number } {
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
