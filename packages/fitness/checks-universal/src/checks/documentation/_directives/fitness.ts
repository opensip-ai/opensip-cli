/**
 * @fileoverview Fitness directive parser
 * (`@fitness-ignore-file`, `@fitness-ignore-next-line`).
 *
 * Extracted from `directive-audit.ts` in Phase C4.
 */

import { collectDirectives, extractIgnoreDirective } from './shared.js';

import type { DirectiveInfo } from './types.js';

function extractFitnessDirective(
  line: string,
  lineIndex: number,
  filePath: string,
  file: string,
): DirectiveInfo | null {
  return extractIgnoreDirective(line, lineIndex, filePath, file, {
    fileMarker: '@fitness-ignore-file',
    nextLineMarker: '@fitness-ignore-next-line',
    source: 'fitness',
    ruleFor: (checkId) => `fitness/${checkId}`,
  });
}

export function parseFitnessDirectives(
  content: string,
  filePath: string,
  file: string,
): DirectiveInfo[] {
  return collectDirectives(content, filePath, file, extractFitnessDirective);
}
