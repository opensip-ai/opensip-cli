export type NativeLexicalKind = 'brace' | 'python';

export interface MaskedSource {
  readonly lines: readonly string[];
  readonly valid: boolean;
}

interface QuoteState {
  readonly escaped: boolean;
  readonly quote: "'" | '"';
}

function advanceQuote(state: QuoteState, character: string | undefined): QuoteState | undefined {
  if (state.escaped) return { ...state, escaped: false };
  if (character === '\\') return { ...state, escaped: true };
  return character === state.quote ? undefined : state;
}

function maskPythonLine(line: string): {
  readonly line: string;
  readonly valid: boolean;
} {
  if (line.includes("'''") || line.includes('"""')) return { line: '', valid: false };
  const output = line.split('');
  let quote: QuoteState | undefined;
  for (const [index, character] of output.entries()) {
    if (quote !== undefined) {
      output[index] = ' ';
      quote = advanceQuote(quote, character);
      continue;
    }
    if (character === '#') {
      output.fill(' ', index);
      break;
    }
    if (character === "'" || character === '"') {
      output[index] = ' ';
      quote = { escaped: false, quote: character };
    }
  }
  return { line: output.join(''), valid: quote === undefined };
}

function maskPython(lines: readonly string[]): MaskedSource {
  const masked: string[] = [];
  let valid = true;
  for (const line of lines) {
    const result = maskPythonLine(line);
    masked.push(result.line);
    valid &&= result.valid;
  }
  return { lines: masked, valid };
}

type BraceMaskKind = 'block-comment' | 'code' | 'double' | 'single' | 'template';

interface BraceMaskState {
  readonly escaped: boolean;
  readonly kind: BraceMaskKind;
}

function advanceBraceLiteral(state: BraceMaskState, character: string | undefined): BraceMaskState {
  if (state.escaped) return { ...state, escaped: false };
  if (character === '\\') return { ...state, escaped: true };
  const closing =
    (state.kind === 'single' && character === "'") ||
    (state.kind === 'double' && character === '"') ||
    (state.kind === 'template' && character === '`');
  return closing ? { escaped: false, kind: 'code' } : state;
}

function literalKind(character: string | undefined): BraceMaskKind | undefined {
  if (character === "'") return 'single';
  if (character === '"') return 'double';
  if (character === '`') return 'template';
  return undefined;
}

interface BraceLineResult {
  readonly line: string;
  readonly state: BraceMaskState;
  readonly valid: boolean;
}

interface BraceMaskStep {
  readonly advance: number;
  readonly state: BraceMaskState;
  readonly stop: boolean;
  readonly valid: boolean;
}

function blockCommentStep(
  output: string[],
  index: number,
  character: string | undefined,
  next: string | undefined,
  state: BraceMaskState,
): BraceMaskStep {
  output[index] = ' ';
  if (character !== '*' || next !== '/') {
    return { advance: 1, state, stop: false, valid: true };
  }
  output[index + 1] = ' ';
  return {
    advance: 2,
    state: { escaped: false, kind: 'code' },
    stop: false,
    valid: true,
  };
}

function literalStep(
  output: string[],
  index: number,
  character: string | undefined,
  state: BraceMaskState,
): BraceMaskStep {
  output[index] = ' ';
  return {
    advance: 1,
    state: advanceBraceLiteral(state, character),
    stop: false,
    valid: true,
  };
}

function codeStep(
  output: string[],
  index: number,
  character: string | undefined,
  next: string | undefined,
  state: BraceMaskState,
): BraceMaskStep {
  if (character === '/' && next === '/') {
    output.fill(' ', index);
    return { advance: 1, state, stop: true, valid: true };
  }
  if (character === '/' && next === '*') {
    output[index] = ' ';
    output[index + 1] = ' ';
    return {
      advance: 2,
      state: { escaped: false, kind: 'block-comment' },
      stop: false,
      valid: true,
    };
  }
  if ((character === '*' && next === '/') || character === '/') {
    // Distinguishing division from a regular-expression literal requires a parser.
    return { advance: 1, state, stop: true, valid: false };
  }
  const kind = literalKind(character);
  if (kind === undefined) return { advance: 1, state, stop: false, valid: true };
  output[index] = ' ';
  return {
    advance: 1,
    state: { escaped: false, kind },
    stop: false,
    valid: true,
  };
}

function braceMaskStep(
  output: string[],
  index: number,
  line: string,
  state: BraceMaskState,
): BraceMaskStep {
  const character = line[index];
  const next = line[index + 1];
  if (state.kind === 'block-comment') {
    return blockCommentStep(output, index, character, next, state);
  }
  if (state.kind !== 'code') return literalStep(output, index, character, state);
  return codeStep(output, index, character, next, state);
}

function maskBraceLine(line: string, initial: BraceMaskState): BraceLineResult {
  const output = line.split('');
  let state = initial;
  let valid = true;
  let index = 0;
  while (index < line.length) {
    const step = braceMaskStep(output, index, line, state);
    state = step.state;
    valid &&= step.valid;
    if (step.stop) break;
    index += step.advance;
  }
  const lineBoundLiteral = state.kind === 'single' || state.kind === 'double' || state.escaped;
  return { line: output.join(''), state, valid: valid && !lineBoundLiteral };
}

function maskBraceLanguage(lines: readonly string[]): MaskedSource {
  const masked: string[] = [];
  let state: BraceMaskState = { escaped: false, kind: 'code' };
  let valid = true;
  for (const line of lines) {
    const result = maskBraceLine(line, state);
    masked.push(result.line);
    state = result.state;
    valid &&= result.valid;
  }
  return { lines: masked, valid };
}

/** Mask literals and comments while preserving source columns for bounded enclosure proof. */
export function maskLexicalSource(kind: NativeLexicalKind, lines: readonly string[]): MaskedSource {
  return kind === 'python' ? maskPython(lines) : maskBraceLanguage(lines);
}
