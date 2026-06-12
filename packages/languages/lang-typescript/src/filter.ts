// @fitness-ignore-file file-length-limit -- framework/content-filter complexity requires single-file cohesion
// @fitness-ignore-file toctou-race-condition -- filterContent cache.get + cache.set on a per-RunScope Map; both operations are synchronous, no async gap, safe in single-threaded Node.js
/**
 * @fileoverview TypeScript scanner-based content filtering
 *
 * Uses the TypeScript scanner (not full AST parser) to identify string literal
 * and comment regions. String content is replaced with spaces of equal length,
 * preserving line/column positions for accurate violation reporting.
 */

import { logger, currentScope } from '@opensip-cli/core';
import { buildLineStarts } from '@opensip-cli/core/languages';
import ts from 'typescript';

// =============================================================================
// TYPES
// =============================================================================

/** Content processed by the TypeScript scanner with string/comment region tracking */
export interface FilteredContent {
  /** Content with string literals replaced by whitespace of equal length */
  readonly code: string;
  /**
   * Content with both string literals AND comments replaced by whitespace
   * of equal length. Use when a check pattern-matches identifiers via regex
   * and would otherwise false-positive on banned-call references that
   * appear in JSDoc / line / block comments documenting the rule
   * (e.g. ``"Replace getDatabase() with the constructor StoreDeps"`` inside
   * a doc string).
   */
  readonly codeNoComments: string;
  /** Original content (unchanged) */
  readonly raw: string;
  /** Set of line numbers (1-based) that are entirely inside comments */
  readonly commentLines: ReadonlySet<number>;
  /** Check if a (1-based line, 0-based column) position is inside a string literal */
  readonly isInString: (line: number, column: number) => boolean;
  /** Check if a (1-based line, 0-based column) position is inside a comment */
  readonly isInComment: (line: number, column: number) => boolean;
}

/** A region in the source text defined by byte offsets */
interface Region {
  readonly start: number;
  readonly end: number;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Build a set of 1-based line numbers from a list of regions.
 * A line is included if any part of it falls within a region.
 *
 * Reuses `buildLineStarts` from `@opensip-cli/core/languages` so UTF-16
 * surrogate-pair / BOM / CRLF handling stays in one place across language
 * adapters.
 */
function linesToSet(content: string, regions: readonly Region[]): ReadonlySet<number> {
  if (regions.length === 0) return new Set();

  const lineStarts = buildLineStarts(content);

  const result = new Set<number>();
  for (const region of regions) {
    for (let lineIdx = 0; lineIdx < lineStarts.length; lineIdx++) {
      const lineStart = lineStarts[lineIdx];
      const lineEnd =
        lineIdx + 1 < lineStarts.length ? lineStarts[lineIdx + 1] - 1 : content.length;
      if (lineStart > region.end) break;
      if (lineEnd >= region.start) {
        result.add(lineIdx + 1); // 1-based
      }
    }
  }
  return result;
}

/**
 * Check if a (1-based line, 0-based column) offset falls within any region.
 */
function isInRegions(
  content: string,
  regions: readonly Region[],
  line: number,
  column: number,
): boolean {
  if (regions.length === 0) return false;

  // Convert line/column to byte offset
  let currentLine = 1;
  let lineStart = 0;
  // eslint-disable-next-line unicorn/no-for-loop -- offset-bearing scan: captures UTF-16 line start
  for (let i = 0; i < content.length; i++) {
    if (currentLine === line) {
      lineStart = i;
      break;
    }
    if (content[i] === '\n') currentLine++;
  }
  if (currentLine !== line) return false;

  const offset = lineStart + column;
  for (const region of regions) {
    if (offset >= region.start && offset < region.end) return true;
  }
  return false;
}

/**
 * Replace characters in the given range with spaces, preserving newlines.
 * Records the range as a string region.
 */
function replaceCharsInRange(
  chars: string[],
  start: number,
  end: number,
  stringRegions: Region[],
): void {
  stringRegions.push({ start, end });
  for (let i = start; i < end; i++) {
    if (chars[i] !== '\n') chars[i] = ' ';
  }
}

// =============================================================================
// MAIN
// =============================================================================

/**
 * Scan content using TypeScript's scanner to identify string and comment regions.
 *
 * String literals are replaced with spaces of equal length, preserving
 * line/column positions. Comments are tracked but not removed (directives
 * live in comments and must be preserved).
 */
// Module-level cache to avoid re-running the TS scanner on the same content.
// Bounded by an idle timer (10 min, matching parse-cache.ts) so long-lived
// embedders don't accumulate cached filter results across runs forever. The
// timer resets each time filterContent runs, so an active session never
// loses its cache.
//
// Filter-content caching now rides on the current `RunScope`'s
// `parseCache.filteredContent` Map (Phase 6 Task 6.4). The previous
// design kept a separate module-level `filterCache` Map + 10-min
// idle timer, which had three failure modes: (1) two tests in the
// same process couldn't isolate state without a `clearFilterCache()`
// call; (2) the timer kept the process alive in environments where
// it wasn't `unref`'d correctly; (3) lifetime drift vs the parse
// cache meant a `clearParseCache()` call left stale filter entries.
// Folding into `RunScope` means the test/run lifecycle owns both
// caches together — one `scope.dispose()` clears them both.
//
// Calling `filterContent(content)` outside any `runWithScope` (e.g.
// a direct unit test of the filter) just bypasses the cache; the
// filtered output is computed every call. That's a documented
// fallback, not a hot-path concern, because production paths always
// run inside a scope established by the CLI's pre-action-hook.

/** Strips TS comments and string literals; result is cached per-content on the active scope. */
export function filterContent(content: string): FilteredContent {
  const scope = currentScope();
  if (scope) {
    const cached = scope.parseCache.filteredContent.get(content) as FilteredContent | undefined;
    if (cached) return cached;
  }

  try {
    const result = filterContentImpl(content);
    if (scope) scope.parseCache.filteredContent.set(content, result);
    return result;
    /* v8 ignore start -- defensive: TypeScript scanner is robust and recovers from malformed input rather than throwing; this fallback exists for theoretical scanner exceptions */
  } catch {
    /*
     * Silent degradation — by design.
     *
     * The TypeScript scanner is best-effort: it CAN throw on resource
     * exhaustion, malformed input the scanner doesn't recognise, or
     * unsupported character classes. When that happens, raising would
     * terminate the entire fitness run because filterContent is called
     * from every TS check that needs string/comment masking.
     *
     * The fallback returns raw content with stub `isInString` /
     * `isInComment` predicates that always return `false`. This is the
     * safest default: callers that pattern-match identifiers will see
     * un-stripped source (so a banned-call reference inside a string or
     * comment may produce a false positive), but they will never
     * see a SILENT TRUNCATION of legitimate code (which is what would
     * happen if the scanner desynced and we returned partially-stripped
     * output).
     *
     * The audit (2026-05-23 F-M1) flagged this as a P3 — the trade-off
     * is intentional but the only signal today is `logger.debug`. A
     * future revision SHOULD widen `FilteredContent` with a
     * `degraded: boolean` flag so callers can branch on it; until then,
     * the debug log line below is the only operator-visible signal.
     */
    logger.debug('Content filter fell back to raw content', {
      evt: 'fitness.content_filter.fallback',
      module: 'fitness:framework',
    });
    const fallback: FilteredContent = {
      code: content,
      codeNoComments: content,
      raw: content,
      commentLines: new Set(),
      isInString: () => false,
      isInComment: () => false,
    };
    if (scope) scope.parseCache.filteredContent.set(content, fallback);
    return fallback;
  }
  /* v8 ignore stop */
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- TS scanner driver: token-by-token loop with per-kind handling; flatter shape would scatter token classification
function filterContentImpl(content: string): FilteredContent {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    content,
  );

  const stringRegions: Region[] = [];
  const commentRegions: Region[] = [];
  const chars = [...content];

  // Depth counter, not a boolean — a `${ `inner` }` construct nests two templates
  // and each `}` that closes a template-expression must be rescanned. A plain
  // boolean flipped off by the inner TemplateTail would leave the outer unrescanned
  // and desync the scanner for the rest of the file (which silently wipes real
  // code to whitespace). Incremented at TemplateHead, decremented at TemplateTail.
  let templateDepth = 0;

  while (true) {
    let token = scanner.scan();
    // @fitness-ignore-next-line unsafe-secret-comparison -- comparing TypeScript SyntaxKind enum, not a secret
    if (token === ts.SyntaxKind.EndOfFileToken) break;

    // After a CloseBraceToken inside ANY template expression, rescan to get TemplateMiddle/TemplateTail
    // @fitness-ignore-next-line unsafe-secret-comparison -- comparing TypeScript SyntaxKind enum, not a secret
    if (token === ts.SyntaxKind.CloseBraceToken && templateDepth > 0) {
      token = scanner.reScanTemplateToken(false);
    }

    const start = scanner.getTokenStart();
    const end = scanner.getTokenEnd();

    switch (token) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral: {
        // Replace content inside quotes/backticks (keep delimiters)
        replaceCharsInRange(chars, start + 1, end - 1, stringRegions);
        break;
      }

      case ts.SyntaxKind.TemplateHead: {
        // `text ${ — replace text between ` and ${
        templateDepth++;
        replaceCharsInRange(chars, start + 1, end - 2, stringRegions);
        break;
      }

      case ts.SyntaxKind.TemplateMiddle: {
        // }text ${ — replace text between } and ${
        replaceCharsInRange(chars, start + 1, end - 2, stringRegions);
        break;
      }

      case ts.SyntaxKind.TemplateTail: {
        // }text` — replace text between } and `
        templateDepth--;
        replaceCharsInRange(chars, start + 1, end - 1, stringRegions);
        break;
      }

      case ts.SyntaxKind.SingleLineCommentTrivia:
      case ts.SyntaxKind.MultiLineCommentTrivia: {
        // Track comment regions but don't modify content
        commentRegions.push({ start, end });
        break;
      }

      // RegularExpressionLiteral — leave unchanged, regex is code
      default: {
        break;
      }
    }
  }

  const code = chars.join('');
  const commentLines = linesToSet(content, commentRegions);

  // Compute `codeNoComments` by additionally replacing comment regions
  // with whitespace. Done as a second pass on a fresh array so `code`
  // (strings-stripped only) and `codeNoComments` (strings + comments
  // stripped) remain available — most checks want one or the other,
  // not both.
  const charsNoComments = [...content];
  for (const region of stringRegions) {
    for (let i = region.start; i < region.end; i++) {
      if (charsNoComments[i] !== '\n') charsNoComments[i] = ' ';
    }
  }
  for (const region of commentRegions) {
    for (let i = region.start; i < region.end; i++) {
      if (charsNoComments[i] !== '\n') charsNoComments[i] = ' ';
    }
  }
  const codeNoComments = charsNoComments.join('');

  return {
    code,
    codeNoComments,
    raw: content,
    commentLines,
    isInString: (line, column) => isInRegions(content, stringRegions, line, column),
    isInComment: (line, column) => isInRegions(content, commentRegions, line, column),
  };
}
