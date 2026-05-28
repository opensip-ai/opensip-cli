/**
 * @fileoverview Body normalization + SHA-256 digest for Python.
 *
 * Extracted from `walk.ts` to keep that module focused on AST traversal
 * and occurrence construction. The body-digest defines the catalog's
 * `bodyHash` contract: walk produces it; resolve consumes it.
 *
 * Normalization differs from C-family adapters in two places:
 *   - Real function bodies also strip a leading docstring (line-oriented
 *     conservative detection: only the common leading-triple-quote
 *     case).
 *   - Synthetic bodies (module-init) skip the docstring strip — the
 *     synthetic text isn't a function body.
 */

import { createHash } from 'node:crypto';

export interface BodyDigest {
  readonly hash: string;
  readonly size: number;
}

export function digestPythonBody(text: string): BodyDigest {
  const normalized = normalizePythonBody(text);
  return { hash: sha256(normalized), size: normalized.length };
}

export function digestSyntheticBody(text: string): BodyDigest {
  const normalized = normalizeWhitespace(stripPythonComments(text));
  return { hash: sha256(normalized), size: normalized.length };
}

/**
 * Strip Python `#` comments and leading-of-body docstrings, then
 * collapse whitespace. Docstring detection is line-oriented and
 * conservative: a line containing only a triple-quoted string at the
 * top of the body is removed. This is good enough for the v1 contract;
 * a parse-tree-driven version is a follow-up if FP rates demand it.
 */
function normalizePythonBody(text: string): string {
  return normalizeWhitespace(stripPythonComments(stripLeadingDocstring(text)));
}

function stripPythonComments(text: string): string {
  // Walk character-by-character, respecting string literals (so `#`
  // inside a string is preserved). Python strings are wrapped by `'`,
  // `"`, or triple-quoted variants.
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '#') {
      i = skipToEndOfLine(text, i);
      continue;
    }
    if (c === '"' || c === "'") {
      const next = consumeStringLiteral(text, i, c);
      out += next.text;
      i = next.index;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/* v8 ignore start */
function skipToEndOfLine(text: string, start: number): number {
  let i = start;
  while (i < text.length && text[i] !== '\n') i++;
  return i;
}

function consumeStringLiteral(
  text: string,
  start: number,
  quote: string,
): { readonly text: string; readonly index: number } {
  const triple = text.slice(start, start + 3) === `${quote}${quote}${quote}`;
  const close = triple ? `${quote}${quote}${quote}` : quote;
  let i = start + (triple ? 3 : 1);
  let buf = text.slice(start, i);
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      buf += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (text.slice(i, i + close.length) === close) {
      buf += close;
      i += close.length;
      break;
    }
    buf += text[i];
    i++;
  }
  return { text: buf, index: i };
}
/* v8 ignore stop */

function stripLeadingDocstring(text: string): string {
  // Match an optional whitespace prefix followed by a triple-quoted
  // string, optionally followed by a newline. Conservative — only
  // handles the common case at the start of the function/module body.
  const match = /^\s*(?:[ru]?(?:'''[\s\S]*?'''|"""[\s\S]*?"""))\s*\n/i.exec(text);
  if (match) return text.slice(match[0].length);
  return text;
}

function normalizeWhitespace(s: string): string {
  return s.replaceAll(/\s+/g, ' ').trim();
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
