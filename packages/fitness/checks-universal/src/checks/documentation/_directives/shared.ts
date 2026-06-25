import type { DirectiveInfo } from './types.js';

export function collectDirectives(
  content: string,
  filePath: string,
  file: string,
  extract: (
    line: string,
    lineIndex: number,
    filePath: string,
    file: string,
  ) => DirectiveInfo | null,
): DirectiveInfo[] {
  const directives: DirectiveInfo[] = [];
  const lines = content.split('\n');

  for (const [i, line] of lines.entries()) {
    if (line === undefined) {
      continue;
    }

    const directive = extract(line, i, filePath, file);
    if (directive) {
      directives.push(directive);
    }
  }

  return directives;
}

export function extractIgnoreDirective(
  line: string,
  lineIndex: number,
  filePath: string,
  file: string,
  input: {
    readonly fileMarker: string;
    readonly nextLineMarker: string;
    readonly source: DirectiveInfo['source'];
    readonly ruleFor: (id: string) => string;
  },
): DirectiveInfo | null {
  let scopeType: 'file' | 'next-line';
  let markerEnd: number;

  const fileIdx = line.indexOf(input.fileMarker);
  const nextLineIdx = line.indexOf(input.nextLineMarker);

  if (fileIdx !== -1) {
    scopeType = 'file';
    markerEnd = fileIdx + input.fileMarker.length;
  } else if (nextLineIdx === -1) {
    return null;
  } else {
    scopeType = 'next-line';
    markerEnd = nextLineIdx + input.nextLineMarker.length;
  }

  const afterMarker = line.slice(markerEnd).trim();
  const spaceIdx = afterMarker.indexOf(' ');
  if (spaceIdx === -1) {
    return null;
  }

  const id = afterMarker.slice(0, spaceIdx);
  const rest = afterMarker.slice(spaceIdx).trim();
  const separatorIdx = rest.indexOf('--');
  if (separatorIdx === -1) {
    return null;
  }

  return {
    file,
    filePath,
    line: lineIndex + 1,
    source: input.source,
    scope: scopeType,
    rule: input.ruleFor(id),
    reason: rest.slice(separatorIdx + 2).trim(),
    raw: line.trim(),
  };
}
