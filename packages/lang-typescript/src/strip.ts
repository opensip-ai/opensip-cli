/**
 * @fileoverview TypeScript string and comment stripping.
 *
 * Implements the LanguageAdapter contract methods stripStrings/stripComments
 * by re-using the rich filterContent implementation in core. Both functions
 * preserve byte length so line/column positions remain stable.
 */

import { filterContent } from '@opensip-tools/core/framework/content-filter.js'

/**
 * Replace string literal content with whitespace of equal length.
 * Quote/backtick delimiters are preserved; only the inside is blanked.
 */
export function stripStrings(content: string): string {
  return filterContent(content).code
}

/**
 * Replace string literals AND comments with whitespace of equal length.
 */
export function stripComments(content: string): string {
  return filterContent(content).codeNoComments
}

// Re-export filterContent and the FilteredContent type for richer
// position-aware needs. The clearFilterCache helper is also re-exported
// for compatibility with any callers that managed it directly.
export { filterContent, clearFilterCache } from '@opensip-tools/core/framework/content-filter.js'
export type { FilteredContent } from '@opensip-tools/core/framework/content-filter.js'
