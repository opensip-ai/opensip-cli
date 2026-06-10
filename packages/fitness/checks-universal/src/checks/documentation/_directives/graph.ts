/**
 * @fileoverview Graph directive parser
 * (`@graph-ignore-file`, `@graph-ignore-next-line`).
 *
 * Modeled on `./fitness.ts`. Graph rule ids are already namespaced
 * (`graph:<…>`), so the parsed id is used directly as `rule`.
 */

import type { DirectiveInfo } from './types.js';

function extractGraphDirective(
  line: string,
  lineIndex: number,
  filePath: string,
  file: string,
): DirectiveInfo | null {
  const fileMarker = '@graph-ignore-file';
  const nextLineMarker = '@graph-ignore-next-line';

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

  // Extract rule id and reason
  const afterMarker = line.slice(markerEnd).trim();
  const spaceIdx = afterMarker.indexOf(' ');
  if (spaceIdx === -1) {
    return null;
  }

  const ruleId = afterMarker.slice(0, spaceIdx);
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
    source: 'graph',
    scope: scopeType,
    rule: ruleId,
    reason,
    raw: line.trim(),
  };
}

export function parseGraphDirectives(
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

    const directive = extractGraphDirective(line, i, filePath, file);
    if (directive) {
      directives.push(directive);
    }
  }

  return directives;
}
