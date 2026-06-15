/**
 * @fileoverview Language-agnostic scanner primitives for source-stripping
 * lexers — the lower half of the strip toolkit.
 *
 * Every `packages/languages/lang-*` strip.ts composes these primitives into a
 * language-specific `scan`, which `makeStripper` (in `strip-utils.ts`) turns
 * into the `{ stripStrings, stripComments }` pair. Each scanner recognizes one
 * lexical shape (regular string, line/block comment, char literal) and emits
 * the half-open `Region`s to replace; `applyRegions` overlays them with spaces
 * while preserving line/column offsets.
 *
 * Split out of `strip-utils.ts` so neither file exceeds the file-length limit;
 * `strip-utils.ts` re-exports everything here, so consumers still import these
 * from `@opensip-cli/core` (or `strip-utils.js`) unchanged.
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

/** Options for `scanRegularString`. */
export interface ScanRegularStringOptions {
  /**
   * When `true`, `\n` is treated as part of the body — the scanner
   * traverses newlines and only stops at the closing quote or EOF.
   * Used by Rust regular strings (which can span multiple lines).
   * Defaults to `false` (matches Java/Go/C++ semantics).
   */
  readonly allowMultiline?: boolean;
}

/**
 * Scan a regular double-quoted string starting at `openQuotePos`
 * (which must reference the opening `"`). Returns the position of the
 * closing quote and the resume index. Honors backslash escapes (`\"`,
 * `\\`, `\n`, etc. by simply advancing 2). By default, stops at
 * unescaped newlines (Java/Go/C++ semantics); pass
 * `{ allowMultiline: true }` for Rust-style strings that may span
 * lines.
 *
 * If the string is unterminated (no closing quote before newline or
 * EOF), returns the unterminated position rather than throwing —
 * callers decide how to handle that case.
 */
export function scanRegularString(
  src: string,
  openQuotePos: number,
  options: ScanRegularStringOptions = {},
): RegStrResult {
  const allowMultiline = options.allowMultiline ?? false;
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
    if (ch === '\n' && !allowMultiline) {
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

/** Result of `scanLineComment` and `scanBlockCommentNonNesting`. */
export interface ScanCommentResult {
  /**
   * Index just past the end of the comment region (i.e. the position
   * where the outer scanner resumes). For line comments without line
   * continuation this is the position of the terminating newline (or
   * EOF); for block comments this is the position immediately after
   * the closing delimiter.
   */
  readonly end: number;
}

/** Options for `scanLineComment`. */
export interface ScanLineCommentOptions {
  /**
   * When `true`, a `\<newline>` (backslash immediately before a
   * newline) is a phase-2 line splice — the comment continues onto
   * the next physical line. Used by C/C++. Defaults to `false`
   * (matches Java/Go semantics).
   */
  readonly allowLineContinuation?: boolean;
}

/**
 * Scan a `//` line comment starting at `start` (which must reference
 * the first `/` of the opener). Returns the index of the next `\n`
 * (or EOF) — i.e. where the outer scanner resumes. The returned index
 * does not include the `\n` itself.
 *
 * Pass `{ allowLineContinuation: true }` for C/C++-style line splices:
 * a `\<newline>` continues the comment onto the next physical line
 * (per C/C++ phase-2 translation). Defaults to `false`; Java and Go
 * comments have no such behavior.
 *
 * Used by lang-cpp (with `allowLineContinuation: true`), lang-java,
 * lang-go, lang-rust.
 */
export function scanLineComment(
  src: string,
  start: number,
  options: ScanLineCommentOptions = {},
): ScanCommentResult {
  const allowLineContinuation = options.allowLineContinuation ?? false;
  const len = src.length;
  const bodyStart = start + 2; // skip the opening //
  let i = bodyStart;
  while (i < len) {
    if (src[i] === '\n') {
      if (allowLineContinuation && hasUnescapedTrailingBackslash(src, bodyStart, i)) {
        // Line splice — continue onto the next physical line.
        i++;
        continue;
      }
      break;
    }
    i++;
  }
  return { end: i };
}

/**
 * Returns true when the position immediately before `newlinePos` is an
 * unescaped backslash — i.e. the count of consecutive backslashes ending
 * at `newlinePos - 1` is odd. The C/C++ phase-2 translation rule treats
 * a single trailing backslash as a line splice, but `\\<newline>` is an
 * escaped backslash with no splice. A single-character lookback at
 * `src[i - 1] === '\\'` cannot tell the two apart and would consume the
 * next physical line as part of the comment incorrectly.
 *
 * `bodyStart` bounds the back-walk so we do not count backslashes from
 * before the `//` opener.
 */
function hasUnescapedTrailingBackslash(
  src: string,
  bodyStart: number,
  newlinePos: number,
): boolean {
  let count = 0;
  let k = newlinePos - 1;
  while (k >= bodyStart && src[k] === '\\') {
    count++;
    k--;
  }
  return count % 2 === 1;
}

/**
 * Scan a non-nesting block comment starting at `start` (which must
 * reference the opening slash). Returns the index just past the
 * closing delimiter — i.e. where the outer scanner resumes. If the
 * comment is unterminated, returns the EOF position.
 *
 * Used by lang-cpp, lang-java, lang-go.
 */
export function scanBlockCommentNonNesting(src: string, start: number): ScanCommentResult {
  const len = src.length;
  let i = start + 2; // skip the opening delimiter
  while (i < len) {
    if (src[i] === '*' && src[i + 1] === '/') {
      i += 2;
      return { end: i };
    }
    i++;
  }
  // Unterminated — record up to EOF.
  return { end: len };
}

/** Result of `scanBlockCommentNesting`. */
export interface ScanNestingBlockCommentResult {
  /** Index just past the closing delimiter (or EOF if unterminated). */
  readonly end: number;
  /**
   * Final depth at scan completion. `0` indicates a balanced (well-
   * terminated) comment. A positive value indicates an unterminated
   * comment — `depth` openers were unmatched at EOF.
   */
  readonly depth: number;
}

/**
 * Scan a Rust-style nested block comment starting at `start` (which
 * must reference the opening slash). Each nested opener increments
 * the depth counter; each closer decrements it. The scan returns when
 * the depth hits zero (balanced) or when EOF is reached (unterminated
 * — `depth > 0`).
 *
 * Used by lang-rust.
 */
export function scanBlockCommentNesting(src: string, start: number): ScanNestingBlockCommentResult {
  const len = src.length;
  let i = start + 2; // skip the opening delimiter
  let depth = 1;
  while (i < len && depth > 0) {
    if (src[i] === '/' && src[i + 1] === '*') {
      depth++;
      i += 2;
    } else if (src[i] === '*' && src[i + 1] === '/') {
      depth--;
      i += 2;
    } else {
      i++;
    }
  }
  return { end: i, depth };
}

/** Result of `scanCharLiteral`. */
export interface ScanCharLiteralResult {
  /**
   * Index just past the char literal — i.e. where the outer scanner
   * resumes. If the close-quote is found within the bound, this is
   * one past the closing apostrophe. If the literal is unterminated
   * (overflow or newline), this is one past the opening apostrophe
   * (the apostrophe is treated as code rather than committing the run
   * as a literal — see lang-java F2 / lang-cpp F5b).
   */
  readonly end: number;
}

/** Options for `scanCharLiteral`. */
export interface ScanCharLiteralOptions {
  /**
   * Maximum number of source positions to scan from the opening
   * quote, inclusive of the close. Defaults to `8` — matches the
   * lang-java / lang-rust heuristic. lang-cpp overrides this to `12`
   * to accommodate unicode escapes such as `'\u{1F600}'` (10 chars
   * including quotes); other C-family adopters should override
   * similarly when their language permits longer escape sequences.
   * The scan-cap is permissive: on overflow it recovers by treating
   * the apostrophe as code.
   */
  readonly maxScan?: number;
}

/**
 * Scan a char literal starting at `start` (which must reference the
 * opening apostrophe). Returns the index just past the literal — or,
 * if the literal does not close within the scan bound, the index
 * immediately after the opening apostrophe (the apostrophe is treated
 * as code rather than committing the consumed run).
 *
 * Branch ordering is load-bearing: the escape-sequence advance MUST
 * run before the close-quote check so escaped-apostrophe char
 * literals do not terminate at the second apostrophe. See lang-java
 * F6.
 *
 * Used by lang-cpp, lang-java (with prefix-stripping at the call
 * site), lang-rust (with the lifetime-vs-literal heuristic at the
 * call site).
 */
export function scanCharLiteral(
  src: string,
  start: number,
  options: ScanCharLiteralOptions = {},
): ScanCharLiteralResult {
  const maxScan = options.maxScan ?? 8;
  const len = src.length;
  const cap = Math.min(start + maxScan, len);
  let j = start + 1;
  let escape = false;
  let closed = false;
  while (j < cap) {
    const ch = src[j];
    // Branch order is load-bearing: escape MUST be checked before the
    // close-quote so escaped-apostrophe is not mis-terminated.
    if (escape) {
      escape = false;
      j++;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      j++;
      continue;
    }
    if (ch === "'") {
      j++;
      closed = true;
      break;
    }
    if (ch === '\n') {
      // Unterminated — bail at the newline.
      break;
    }
    j++;
  }
  if (closed) {
    return { end: j };
  }
  // Overflow / unterminated — treat the apostrophe as code rather
  // than committing the consumed run. The caller advances past the
  // opening apostrophe alone.
  return { end: start + 1 };
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
