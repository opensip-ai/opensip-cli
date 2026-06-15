/**
 * @fileoverview Fitness directive parser
 * (`@fitness-ignore-file`, `@fitness-ignore-next-line`).
 *
 * Extracted from `directive-audit.ts` in Phase C4.
 */

import type { DirectiveInfo } from './types.js';

function extractFitnessDirective(
  line: string,
  lineIndex: number,
  filePath: string,
  file: string,
): DirectiveInfo | null {
  const fileMarker = '@fitness-ignore-file';
  const nextLineMarker = '@fitness-ignore-next-line';

  let scopeType: 'file' | 'next-line';
  let markerEnd: number;

  const fileIdx = line.indexOf(fileMarker);
  const nextLineIdx = line.indexOf(nextLineMarker);

  if (fileIdx !== -1) {
    scopeType = 'file';
    markerEnd = fileIdx + fileMarker.length;
  } else if (nextLineIdx === -1) {
    return null;
  } else {
    scopeType = 'next-line';
    markerEnd = nextLineIdx + nextLineMarker.length;
  }

  // Extract check ID and reason
  const afterMarker = line.slice(markerEnd).trim();
  const spaceIdx = afterMarker.indexOf(' ');
  if (spaceIdx === -1) {
    return null;
  }

  const checkId = afterMarker.slice(0, spaceIdx);
  const rest = afterMarker.slice(spaceIdx).trim();

  // Look for -- separator
  const separatorIdx = rest.indexOf('--');
  if (separatorIdx === -1) {
    return null;
  }

  const reason = rest.slice(separatorIdx + 2).trim();

  return {
    file,
    filePath,
    line: lineIndex + 1,
    source: 'fitness',
    scope: scopeType,
    rule: `fitness/${checkId}`,
    reason,
    raw: line.trim(),
  };
}

export function parseFitnessDirectives(
  content: string,
  filePath: string,
  file: string,
): DirectiveInfo[] {
  const directives: DirectiveInfo[] = [];
  const lines = content.split('\n');

  for (const [i, line] of lines.entries()) {
    if (line === undefined) {
      continue;
    }

    const directive = extractFitnessDirective(line, i, filePath, file);
    if (directive) {
      directives.push(directive);
    }
  }

  return directives;
}
