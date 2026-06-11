/**
 * @fileoverview TypeScript string and comment stripping.
 *
 * Implements the LanguageAdapter contract methods stripStrings/stripComments
 * by re-using the rich filterContent implementation in this package. Both
 * functions preserve byte length so line/column positions remain stable.
 *
 * For the canonical rationale on why a TS-AST-aware stripper coexists
 * with the regex-based language-agnostic strippers in
 * `@opensip-tools/fitness/framework/strip-literals.ts`, see that file's
 * header. The dispatch boundary that selects between the two families
 * is `applyContentFilter` in
 * `@opensip-tools/core/languages/content-filter-dispatch.ts`
 * (audit 2026-05-23 F9).
 */

import { filterContent } from './filter.js';

/**
 * Replace string literal content with whitespace of equal length.
 * Quote/backtick delimiters are preserved; only the inside is blanked.
 */
export function stripStrings(content: string): string {
  return filterContent(content).code;
}

/**
 * Replace string literals AND comments with whitespace of equal length.
 */
export function stripComments(content: string): string {
  return filterContent(content).codeNoComments;
}
