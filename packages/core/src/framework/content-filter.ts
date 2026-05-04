// @fitness-ignore-file file-length-limits -- framework/content-filter complexity requires single-file cohesion
/**
 * @fileoverview TypeScript scanner-based content filtering
 *
 * Uses the TypeScript scanner (not full AST parser) to identify string literal
 * and comment regions. String content is replaced with spaces of equal length,
 * preserving line/column positions for accurate violation reporting.
 */

import { logger } from '../lib/logger.js'
import ts from 'typescript'


// =============================================================================
// TYPES
// =============================================================================

/** Content processed by the TypeScript scanner with string/comment region tracking */
export interface FilteredContent {
  /** Content with string literals replaced by whitespace of equal length */
  readonly code: string
  /**
   * Content with both string literals AND comments replaced by whitespace
   * of equal length. Use when a check pattern-matches identifiers via regex
   * and would otherwise false-positive on banned-call references that
   * appear in JSDoc / line / block comments documenting the rule
   * (e.g. ``"Replace getDatabase() with the constructor StoreDeps"`` inside
   * a doc string).
   */
  readonly codeNoComments: string
  /** Original content (unchanged) */
  readonly raw: string
  /** Set of line numbers (1-based) that are entirely inside comments */
  readonly commentLines: ReadonlySet<number>
  /** Check if a (1-based line, 0-based column) position is inside a string literal */
  readonly isInString: (line: number, column: number) => boolean
  /** Check if a (1-based line, 0-based column) position is inside a comment */
  readonly isInComment: (line: number, column: number) => boolean
}

/** A region in the source text defined by byte offsets */
interface Region {
  readonly start: number
  readonly end: number
}

// =============================================================================
// HELPERS
// =============================================================================

/** Build an array of byte offsets where each line starts. */
function buildLineStarts(content: string): number[] {
  const lineStarts: number[] = [0]
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') lineStarts.push(i + 1)
  }
  return lineStarts
}

/**
 * Build a set of 1-based line numbers from a list of regions.
 * A line is included if any part of it falls within a region.
 */
function linesToSet(content: string, regions: readonly Region[]): ReadonlySet<number> {
  if (regions.length === 0) return new Set()

  const lineStarts = buildLineStarts(content)

  const result = new Set<number>()
  for (const region of regions) {
    for (let lineIdx = 0; lineIdx < lineStarts.length; lineIdx++) {
      const lineStart = lineStarts[lineIdx]
      const lineEnd = lineIdx + 1 < lineStarts.length ? lineStarts[lineIdx + 1] - 1 : content.length
      if (lineStart > region.end) break
      if (lineEnd >= region.start) {
        result.add(lineIdx + 1) // 1-based
      }
    }
  }
  return result
}

/**
 * Check if a (1-based line, 0-based column) offset falls within any region.
 */
function isInRegions(content: string, regions: readonly Region[], line: number, column: number): boolean {
  if (regions.length === 0) return false

  // Convert line/column to byte offset
  let currentLine = 1
  let lineStart = 0
  for (let i = 0; i < content.length; i++) {
    if (currentLine === line) {
      lineStart = i
      break
    }
    if (content[i] === '\n') currentLine++
  }
  if (currentLine !== line) return false

  const offset = lineStart + column
  for (const region of regions) {
    if (offset >= region.start && offset < region.end) return true
  }
  return false
}

/**
 * Replace characters in the given range with spaces, preserving newlines.
 * Records the range as a string region.
 */
function replaceCharsInRange(chars: string[], start: number, end: number, stringRegions: Region[]): void {
  stringRegions.push({ start, end })
  for (let i = start; i < end; i++) {
    if (chars[i] !== '\n') chars[i] = ' '
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
const FILTER_CACHE_IDLE_TIMEOUT_MS = 10 * 60 * 1000
const filterCache = new Map<string, FilteredContent>()
let filterCacheIdleTimer: ReturnType<typeof setTimeout> | null = null

function scheduleFilterCacheClear(): void {
  if (filterCacheIdleTimer) clearTimeout(filterCacheIdleTimer)
  filterCacheIdleTimer = setTimeout(() => {
    filterCache.clear()
    filterCacheIdleTimer = null
  }, FILTER_CACHE_IDLE_TIMEOUT_MS)
  filterCacheIdleTimer.unref()
}

/** Clear the filter cache (call between runs or on memory pressure) */
export function clearFilterCache(): void {
  filterCache.clear()
  if (filterCacheIdleTimer) {
    clearTimeout(filterCacheIdleTimer)
    filterCacheIdleTimer = null
  }
}

export function filterContent(content: string): FilteredContent {
  const cached = filterCache.get(content)
  if (cached) {
    scheduleFilterCacheClear()
    return cached
  }

  try {
    const result = filterContentImpl(content)
    filterCache.set(content, result)
    scheduleFilterCacheClear()
    return result
  } catch {
    // Graceful degradation — return raw content if scanner fails
    logger.debug('Content filter fell back to raw content', { evt: 'fitness.content_filter.fallback', module: 'fitness:framework' })
    const fallback: FilteredContent = {
      code: content,
      codeNoComments: content,
      raw: content,
      commentLines: new Set(),
      isInString: () => false,
      isInComment: () => false,
    }
    filterCache.set(content, fallback)
    return fallback
  }
}

function filterContentImpl(content: string): FilteredContent {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, content)

  const stringRegions: Region[] = []
  const commentRegions: Region[] = []
  const chars = [...content]

  // Depth counter, not a boolean — a `${ `inner` }` construct nests two templates
  // and each `}` that closes a template-expression must be rescanned. A plain
  // boolean flipped off by the inner TemplateTail would leave the outer unrescanned
  // and desync the scanner for the rest of the file (which silently wipes real
  // code to whitespace). Incremented at TemplateHead, decremented at TemplateTail.
  let templateDepth = 0

  // eslint-disable-next-line no-constant-condition -- scanner loop terminates on EndOfFileToken
  while (true) {
    let token = scanner.scan()
    // @fitness-ignore-next-line unsafe-secret-comparison -- comparing TypeScript SyntaxKind enum, not a secret
    if (token === ts.SyntaxKind.EndOfFileToken) break

    // After a CloseBraceToken inside ANY template expression, rescan to get TemplateMiddle/TemplateTail
    // @fitness-ignore-next-line unsafe-secret-comparison -- comparing TypeScript SyntaxKind enum, not a secret
    if (token === ts.SyntaxKind.CloseBraceToken && templateDepth > 0) {
      token = scanner.reScanTemplateToken(false)
    }

    const start = scanner.getTokenStart()
    const end = scanner.getTokenEnd()

    switch (token) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral: {
        // Replace content inside quotes/backticks (keep delimiters)
        replaceCharsInRange(chars, start + 1, end - 1, stringRegions)
        break
      }

      case ts.SyntaxKind.TemplateHead: {
        // `text ${ — replace text between ` and ${
        templateDepth++
        replaceCharsInRange(chars, start + 1, end - 2, stringRegions)
        break
      }

      case ts.SyntaxKind.TemplateMiddle: {
        // }text ${ — replace text between } and ${
        replaceCharsInRange(chars, start + 1, end - 2, stringRegions)
        break
      }

      case ts.SyntaxKind.TemplateTail: {
        // }text` — replace text between } and `
        templateDepth--
        replaceCharsInRange(chars, start + 1, end - 1, stringRegions)
        break
      }

      case ts.SyntaxKind.SingleLineCommentTrivia:
      case ts.SyntaxKind.MultiLineCommentTrivia: {
        // Track comment regions but don't modify content
        commentRegions.push({ start, end })
        break
      }

      // RegularExpressionLiteral — leave unchanged, regex is code
      default:
        break
    }
  }

  const code = chars.join('')
  const commentLines = linesToSet(content, commentRegions)

  // Compute `codeNoComments` by additionally replacing comment regions
  // with whitespace. Done as a second pass on a fresh array so `code`
  // (strings-stripped only) and `codeNoComments` (strings + comments
  // stripped) remain available — most checks want one or the other,
  // not both.
  const charsNoComments = [...content]
  for (const region of stringRegions) {
    for (let i = region.start; i < region.end; i++) {
      if (charsNoComments[i] !== '\n') charsNoComments[i] = ' '
    }
  }
  for (const region of commentRegions) {
    for (let i = region.start; i < region.end; i++) {
      if (charsNoComments[i] !== '\n') charsNoComments[i] = ' '
    }
  }
  const codeNoComments = charsNoComments.join('')

  return {
    code,
    codeNoComments,
    raw: content,
    commentLines,
    isInString: (line, column) => isInRegions(content, stringRegions, line, column),
    isInComment: (line, column) => isInRegions(content, commentRegions, line, column),
  }
}
