/**
 * @fileoverview Cross-language helpers for source-stripping lexers.
 *
 * Every language adapter under packages/languages/lang-* has a strip.ts
 * that recognizes that language's strings + comments and replaces them
 * with whitespace (preserving line/column offsets so checks can report
 * accurate positions). The *lexer* part is language-specific (different
 * string-prefix rules, different comment syntax, raw/text-block
 * variations) — but several pieces of glue are byte-identical across
 * every pack. Those split across two files:
 *
 *  - The low-level scanner primitives (`Region`, `scanRegularString`,
 *    `scanLineComment`, `scanBlockCommentNonNesting`,
 *    `scanBlockCommentNesting`, `scanCharLiteral`, `applyRegions`) live in
 *    `strip-scanners.ts` and are re-exported here for a single import site.
 *  - This file owns the assembly seam: `ScanResult` (the
 *    scanner→mechanics contract), `Stripper`, and `makeStripper` — the
 *    template method that turns a language-specific `scan` into the
 *    byte-identical `{ stripStrings, stripComments }` pair — plus the
 *    parse-layer utilities `buildLineStarts` and `isIdentChar`.
 *
 * These helpers live in core because:
 *   (a) they are language-agnostic by construction — no string-prefix
 *       table, no comment syntax, no language-specific assumptions;
 *   (b) the layered architecture (CLAUDE.md) forbids peer language
 *       adapters from importing each other, but every adapter can
 *       depend on core, which is upstream of the entire peer tier;
 *   (c) the same helpers are likely to be needed by future language
 *       adapters (Ruby, PHP, Swift, etc.) — extracting now removes a
 *       pasted-in-every-pack drag on future contribution.
 */

import { applyRegions, type Region } from './strip-scanners.js';

// Re-export the scanner primitives so consumers keep a single import site
// (`strip-utils.js` / the core barrel) regardless of which file defines them.
export * from './strip-scanners.js';

/** Scanner→mechanics contract: a source's string + comment regions (the old per-pack `interface Scan`). */
export interface ScanResult {
  readonly stringRegions: Region[];
  readonly commentRegions: Region[];
}

/** The `{ stripStrings, stripComments }` pair `makeStripper` returns. */
export interface Stripper {
  readonly stripStrings: (content: string) => string;
  readonly stripComments: (content: string) => string;
}

/** Bind a language-specific `scan` to the shared strip mechanics (see file header). */
export function makeStripper(scan: (src: string) => ScanResult): Stripper {
  return {
    stripStrings(content: string): string {
      const { stringRegions } = scan(content);
      return applyRegions(content, stringRegions);
    },
    stripComments(content: string): string {
      const { stringRegions, commentRegions } = scan(content);
      return applyRegions(content, [...stringRegions, ...commentRegions]);
    },
  };
}

/**
 * Precompute the starting offset of each line in `src` (0-indexed).
 * The returned array `L` has `L[0] === 0` and `L[i]` is the offset of
 * the character immediately after the `i`th newline. Used by every
 * line/column resolver in the parse layer.
 */
export function buildLineStarts(src: string): readonly number[] {
  const starts: number[] = [0];
  // Index loop: we need the UTF-16 code unit offset (i + 1) for line starts.
  // [...src] / `for-of` would split by code points and break offsets for
  // surrogate pairs (any source containing emoji, astral characters, etc.).
  // eslint-disable-next-line unicorn/no-for-loop -- offset-bearing scan, not pure iteration
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/**
 * Identifier-character predicate over the C-identifier char class:
 * ASCII letters (`A-Z`, `a-z`), ASCII digits (`0-9`), and `_`. Returns
 * `false` for `undefined`/empty input.
 *
 * Used by the C-family strip lexers' prefix-anchor guards: if the
 * character before a candidate string/char-literal prefix is an
 * identifier character, the candidate is actually the middle/end of an
 * identifier (e.g. `abcL"foo"` — the `L` is not a wide-string prefix
 * here), so the prefix matchers must reject. Shared across lang-cpp and
 * lang-python (which both anchor prefixes on identifier boundaries).
 */
export function isIdentChar(ch: string | undefined): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    ch === '_'
  );
}
