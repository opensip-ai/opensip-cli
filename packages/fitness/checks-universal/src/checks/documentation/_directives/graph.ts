/**
 * @fileoverview Graph directive parser
 * (`@graph-ignore-file`, `@graph-ignore-next-line`).
 *
 * Modeled on `./fitness.ts`. Graph rule ids are already namespaced
 * (`graph:<…>`), so the parsed id is used directly as `rule`.
 */

import { collectDirectives, extractIgnoreDirective } from './shared.js';

import type { DirectiveInfo } from './types.js';

function extractGraphDirective(
  line: string,
  lineIndex: number,
  filePath: string,
  file: string,
): DirectiveInfo | null {
  return extractIgnoreDirective(line, lineIndex, filePath, file, {
    fileMarker: '@graph-ignore-file',
    nextLineMarker: '@graph-ignore-next-line',
    source: 'graph',
    ruleFor: (ruleId) => ruleId,
  });
}

export function parseGraphDirectives(
  content: string,
  filePath: string,
  file: string,
): DirectiveInfo[] {
  return collectDirectives(content, filePath, file, extractGraphDirective);
}
