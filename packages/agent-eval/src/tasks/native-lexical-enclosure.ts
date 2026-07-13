import { maskLexicalSource, type NativeLexicalKind } from './native-source-masking.js';

interface NamedDeclaration {
  readonly column: number;
  readonly kind: NativeLexicalKind;
  readonly name: string;
}

export type NativeMatchProjection =
  | { readonly kind: 'caller'; readonly name: string }
  | { readonly kind: 'declaration' | 'unresolved' };

function patternStarts(line: string, pattern: RegExp): ReadonlySet<number> {
  const flags = `${pattern.flags.replace(/[gy]/gu, '')}g`;
  const expression = new RegExp(pattern.source, flags);
  const starts = new Set<number>();
  for (const match of line.matchAll(expression)) {
    if (match.index !== undefined) starts.add(match.index);
  }
  return starts;
}

function hasSinglePatternOccurrence(line: string | undefined, pattern: RegExp): boolean {
  return line !== undefined && patternStarts(line, pattern).size === 1;
}

function declarationOnLine(line: string, kind: NativeLexicalKind): NamedDeclaration | undefined {
  const expression =
    kind === 'python'
      ? /^( *)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/u
      : /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u;
  const match = expression.exec(line);
  const name = kind === 'python' ? match?.[2] : match?.[1];
  return match === null || name === undefined ? undefined : { column: match.index, kind, name };
}

function pythonEncloses(
  lines: readonly string[],
  declarationIndex: number,
  matchIndex: number,
  searchedPattern: RegExp,
): boolean {
  const declaration = lines[declarationIndex];
  const matchLine = lines[matchIndex];
  if (declaration === undefined || matchLine === undefined) return false;
  const declarationIndent = /^( *)/u.exec(declaration)?.[1]?.length;
  if (declarationIndent !== 0 || !declaration.trimEnd().endsWith(':')) return false;
  if (patternStarts(matchLine, searchedPattern).size === 0) return false;
  for (let index = declarationIndex + 1; index <= matchIndex; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) continue;
    const indent = /^( *)/u.exec(line)?.[1]?.length;
    if (indent === undefined || line.includes('\t') || indent <= declarationIndent) return false;
  }
  return true;
}

interface SourcePosition {
  readonly column: number;
  readonly line: number;
}

interface PositionedCharacter extends SourcePosition {
  readonly character: string;
}

function positionedCharacters(
  lines: readonly string[],
  start: SourcePosition,
  endLine: number,
): readonly PositionedCharacter[] {
  const characters: PositionedCharacter[] = [];
  for (let lineIndex = start.line; lineIndex <= endLine; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === undefined) return [];
    const startColumn = lineIndex === start.line ? start.column : 0;
    for (let column = startColumn; column < line.length; column += 1) {
      characters.push({
        character: line[column] ?? '',
        column,
        line: lineIndex,
      });
    }
    characters.push({ character: '\n', column: line.length, line: lineIndex });
  }
  return characters;
}

function parameterListEnd(characters: readonly PositionedCharacter[]): number | undefined {
  let depth = 0;
  let seen = false;
  for (const [index, { character }] of characters.entries()) {
    if (character === '(') {
      depth += 1;
      seen = true;
    } else if (character === ')' && seen) {
      depth -= 1;
      if (depth < 0) return undefined;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function validReturnTypeSuffix(value: string): boolean {
  const suffix = value.trim();
  return (
    suffix.length === 0 ||
    (suffix.startsWith(':') && suffix.slice(1).trim().length > 0 && !/[{};=]/u.test(suffix))
  );
}

function functionBodyOpening(
  lines: readonly string[],
  declarationIndex: number,
  declarationColumn: number,
  matchIndex: number,
): SourcePosition | undefined {
  const characters = positionedCharacters(
    lines,
    { column: declarationColumn, line: declarationIndex },
    matchIndex,
  );
  const parameterEnd = parameterListEnd(characters);
  if (parameterEnd === undefined) return undefined;
  let suffix = '';
  for (const candidate of characters.slice(parameterEnd + 1)) {
    if (candidate.character === '{') {
      return validReturnTypeSuffix(suffix)
        ? { column: candidate.column, line: candidate.line }
        : undefined;
    }
    suffix += candidate.character;
    if (candidate.character === ';' || suffix.includes('=>')) return undefined;
  }
  return undefined;
}

function braceBodyEncloses(
  lines: readonly string[],
  opening: SourcePosition,
  matchIndex: number,
  searchedPattern: RegExp,
): boolean {
  const matchLine = lines[matchIndex];
  if (matchLine === undefined) return false;
  const occurrences = patternStarts(matchLine, searchedPattern);
  if (occurrences.size === 0) return false;
  let depth = 0;
  for (const candidate of positionedCharacters(lines, opening, matchIndex)) {
    if (candidate.line === matchIndex && occurrences.has(candidate.column) && depth > 0)
      return true;
    if (candidate.character === '{') depth += 1;
    if (candidate.character === '}') depth -= 1;
    if (depth <= 0 && candidate.character === '}') return false;
  }
  return false;
}

function languageKind(path: string): NativeLexicalKind | undefined {
  if (path.endsWith('.py')) return 'python';
  return /\.(?:[cm]?[jt]sx?)$/u.test(path) ? 'brace' : undefined;
}

function braceDeclarationIsTopLevel(lines: readonly string[], declarationIndex: number): boolean {
  let depth = 0;
  for (const line of lines.slice(0, declarationIndex)) {
    for (const character of line) {
      if (character === '{') depth += 1;
      if (character === '}') depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function declarationEncloses(
  lines: readonly string[],
  declaration: NamedDeclaration,
  declarationIndex: number,
  matchIndex: number,
  searchedPattern: RegExp,
): boolean {
  if (declaration.kind === 'python') {
    return pythonEncloses(lines, declarationIndex, matchIndex, searchedPattern);
  }
  const opening = functionBodyOpening(lines, declarationIndex, declaration.column, matchIndex);
  return opening !== undefined && braceBodyEncloses(lines, opening, matchIndex, searchedPattern);
}

function projectMaskedMatch(
  lines: readonly string[],
  kind: NativeLexicalKind,
  matchIndex: number,
  searchedPattern: RegExp,
): NativeMatchProjection {
  if (!hasSinglePatternOccurrence(lines[matchIndex], searchedPattern)) {
    return { kind: 'unresolved' };
  }
  for (let index = matchIndex; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const declaration = declarationOnLine(line, kind);
    if (declaration === undefined) continue;
    if (kind === 'brace' && !braceDeclarationIsTopLevel(lines, index)) continue;
    searchedPattern.lastIndex = 0;
    if (index === matchIndex && searchedPattern.test(declaration.name)) {
      return { kind: 'declaration' };
    }
    if (declarationEncloses(lines, declaration, index, matchIndex, searchedPattern)) {
      return { kind: 'caller', name: declaration.name };
    }
  }
  return { kind: 'unresolved' };
}

/** Conservatively prove that a native text match is a declaration or is inside a named function. */
export function projectLexicalEnclosingFunction(input: {
  readonly contextStartLine: number;
  readonly lines: readonly string[];
  readonly matchIndex: number;
  readonly path: string;
  readonly searchedPattern: RegExp;
}): NativeMatchProjection {
  const kind = languageKind(input.path);
  if (kind === undefined || input.contextStartLine !== 1) return { kind: 'unresolved' };
  const sourceLines = input.lines.slice(0, input.matchIndex + 1);
  const masked = maskLexicalSource(kind, sourceLines);
  if (!masked.valid) return { kind: 'unresolved' };
  return projectMaskedMatch(masked.lines, kind, input.matchIndex, input.searchedPattern);
}
