/**
 * @fileoverview Fitness ignore-directive parsing — thin wrappers over the
 * shared core suppression scanner (ADR-0014).
 *
 * The directive-scanning algorithm lives once in `@opensip-tools/core`
 * (`scanSuppressionDirectives`). These wrappers bind it to the fitness
 * keywords (`@fitness-ignore-file` / `@fitness-ignore-next-line`) and the
 * historical `boolean` / `Set<number>` signatures the fitness framework and
 * its tests depend on. No scanning logic is duplicated here.
 */

import { scanSuppressionDirectives, type SuppressionKeywords } from '@opensip-tools/core';

export const FITNESS_KEYWORDS: SuppressionKeywords = {
  file: '@fitness-ignore-file',
  nextLine: '@fitness-ignore-next-line',
};

/**
 * Parse file-level ignore directive from file content.
 * Returns true if the file should be entirely ignored for that check.
 */
export function parseFileIgnoreDirective(
  content: string,
  checkId: string | readonly string[],
): boolean {
  const checkIds: readonly string[] = Array.isArray(checkId) ? checkId : [checkId];
  const { fileIgnoredIds } = scanSuppressionDirectives(content, FITNESS_KEYWORDS);
  return checkIds.some((id) => fileIgnoredIds.has(id));
}

/**
 * Parse next-line ignore directives from file content.
 * Returns the set of 1-based line numbers that should be ignored.
 */
export function parseIgnoreDirectives(
  content: string,
  checkId: string | readonly string[],
): Set<number> {
  const checkIds: readonly string[] = Array.isArray(checkId) ? checkId : [checkId];
  const { lineIgnoredIds } = scanSuppressionDirectives(content, FITNESS_KEYWORDS);
  const ignoredLines = new Set<number>();
  for (const [line, ids] of lineIgnoredIds) {
    if (checkIds.some((id) => ids.has(id))) ignoredLines.add(line);
  }
  return ignoredLines;
}
