/**
 * @fileoverview Cross-language helpers for source-stripping lexers.
 *
 * Every language adapter under packages/languages/lang-* has a strip.ts
 * that recognizes that language's strings + comments and replaces them
 * with whitespace (preserving line/column offsets so checks can report
 * accurate positions). The *lexer* part is language-specific (different
 * string-prefix rules, different comment syntax, raw/text-block
 * variations) — but three pieces of glue are byte-identical across
 * every pack:
 *
 *  - `Region` — the half-open `[start, end)` interval the scanner emits
 *    for each chunk of source to be replaced.
 *  - `scanRegularString` — a generic double-quoted-string scanner that
 *    honors backslash escapes and stops at unescaped newlines. The
 *    "regular" prefix distinguishes it from language-specific scanners
 *    for raw strings, byte strings, text blocks, f-strings, etc.
 *  - `applyRegions` — the region-overlay primitive that takes a source
 *    string + region list and returns a same-length string with each
 *    region replaced by spaces. Line breaks are preserved so AST
 *    offsets remain accurate.
 *  - `buildLineStarts` — precomputes a `lineStarts` index for a source
 *    string. Used by every parser to translate byte offsets into
 *    (line, column) pairs in O(log n) per lookup.
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

/** Half-open region `[start, end)` for region-overlay strippers. */
export interface Region {
  readonly start: number;
  readonly end: number;
}

/** Result of `scanRegularString`. */
export interface RegStrResult {
  /** Index of the closing `"` (or EOF / newline position for unterminated). */
  readonly contentEnd: number;
  /** Index after the closing quote — where the outer scanner resumes. */
  readonly next: number;
}

/**
 * Scan a regular double-quoted string starting at `openQuotePos`
 * (which must reference the opening `"`). Returns the position of the
 * closing quote and the resume index. Honors backslash escapes (`\"`,
 * `\\`, `\n`, etc. by simply advancing 2). Stops at unescaped newlines
 * — no language we currently support permits raw newlines inside
 * regular double-quoted strings; the language-specific scanners are
 * responsible for raw strings, text blocks, and other multi-line
 * variants.
 *
 * If the string is unterminated (no closing quote before newline or
 * EOF), returns the unterminated position rather than throwing —
 * callers decide how to handle that case.
 */
export function scanRegularString(src: string, openQuotePos: number): RegStrResult {
  const len = src.length;
  let i = openQuotePos + 1;
  while (i < len) {
    const ch = src[i];
    if (ch === '\\') {
      // Skip escape sequence — at minimum 2 chars (\n, \", etc.)
      i += 2;
      continue;
    }
    if (ch === '"') {
      return { contentEnd: i, next: i + 1 };
    }
    if (ch === '\n') {
      // Unterminated regular string — language-specific scanners must
      // decide how to recover; we stop here so we don't consume the
      // rest of the file.
      return { contentEnd: i, next: i };
    }
    i++;
  }
  // Unterminated — return EOF position.
  return { contentEnd: len, next: len };
}

/**
 * Replace each region with spaces, preserving newlines and overall
 * length. Indexes into `src` and out remain identical, so any
 * line/column derived from the original string is still valid.
 *
 * The `Region[]` is treated as readonly; callers may pass either
 * regions from a comment scan or regions from a string scan (or both).
 */
export function applyRegions(src: string, regions: readonly Region[]): string {
  if (regions.length === 0) return src;
  // eslint-disable-next-line unicorn/prefer-spread -- split('') keeps UTF-16 unit indexing; spread/Array.from use code points and break offsets
  const buf = src.split('');
  for (const r of regions) {
    for (let i = r.start; i < r.end; i++) {
      if (buf[i] !== '\n') buf[i] = ' ';
    }
  }
  return buf.join('');
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
