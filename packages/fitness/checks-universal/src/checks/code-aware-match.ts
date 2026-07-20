import { currentScope, getParseTree } from '@opensip-cli/core';
import { stripStringsAndCommentsPreservingPositions } from '@opensip-cli/fitness';

export interface SourceSpan {
  readonly start: number;
  readonly end: number;
}

export interface StaticModuleReference {
  readonly index: number;
  readonly keyword: 'import' | 'export';
  readonly clauseCode: string;
  readonly moduleSpecifier: string;
  readonly runtimeImport: boolean;
  readonly runtimeNamedBindingCount: number;
  readonly runtimeBindingNames: readonly string[];
  readonly namespaceImport: boolean;
}

/**
 * Build a position-preserving view containing code tokens only.
 *
 * Literal-sensitive checks match against the original source so module names,
 * route paths, and configuration values remain visible. This companion view
 * lets them prove that the syntactic start of a match is real code rather than
 * an example embedded in a string or comment.
 */
export function createCodeMask(filePath: string, content: string): string {
  const adapter = currentScope()?.languages.forFile(filePath);
  const mask =
    adapter?.stripComments(content, filePath) ??
    stripStringsAndCommentsPreservingPositions(content);
  if (adapter?.id !== 'typescript') return mask;
  const tree = getParseTree(adapter, filePath, content);
  return tree ? stripAstNonCodeSpans(content, mask, tree) : mask;
}

interface OpaqueParseNode {
  readonly text?: unknown;
  readonly parent?: unknown;
  readonly initializer?: unknown;
  readonly name?: unknown;
  readonly propertyName?: unknown;
  readonly expression?: unknown;
  readonly argumentExpression?: unknown;
  readonly type?: unknown;
  readonly left?: unknown;
  readonly right?: unknown;
  readonly operatorToken?: unknown;
  readonly elements?: readonly unknown[];
  readonly properties?: readonly unknown[];
  readonly moduleSpecifier?: unknown;
  readonly moduleReference?: unknown;
  readonly importClause?: unknown;
  readonly exportClause?: unknown;
  readonly namedBindings?: unknown;
  readonly tag?: unknown;
  readonly template?: unknown;
  readonly isTypeOnly?: unknown;
  readonly containsOnlyTriviaWhiteSpaces?: unknown;
  readonly getStart?: (sourceFile?: unknown) => number;
  readonly getEnd?: () => number;
  readonly getText?: (sourceFile?: unknown) => string;
  readonly getChildren?: (sourceFile?: unknown) => readonly unknown[];
}

function isOpaqueParseNode(value: unknown): value is OpaqueParseNode {
  return typeof value === 'object' && value !== null;
}

export interface StaticStringLiteral {
  readonly value: string;
  readonly start: number;
  readonly end: number;
  readonly role: 'object-property' | 'initializer' | 'assignment' | 'array-element' | 'other';
  readonly propertyName?: string;
}

function staticQuotedNodeText(
  node: unknown,
  tree: OpaqueParseNode,
  content: string,
  allowBacktick = true,
): string | undefined {
  if (!isOpaqueParseNode(node) || typeof node.text !== 'string' || !node.getStart || !node.getEnd) {
    return undefined;
  }
  const start = node.getStart(tree);
  const end = node.getEnd();
  const quote = content[start];
  return (quote === '"' || quote === "'" || (allowBacktick && quote === '`')) &&
    content[end - 1] === quote
    ? node.text
    : undefined;
}

function transparentExpressionNode(node: OpaqueParseNode, tree: OpaqueParseNode): OpaqueParseNode {
  let current = node;
  while (isOpaqueParseNode(current.expression)) {
    const source = current.getText?.(tree).trim() ?? '';
    const isTransparent =
      current.type !== undefined ||
      (source.startsWith('(') && source.endsWith(')')) ||
      source.endsWith('!');
    if (!isTransparent) break;
    current = current.expression;
  }
  return current;
}

function staticComputedNodeText(
  node: OpaqueParseNode,
  tree: OpaqueParseNode,
  content: string,
): string | undefined {
  return staticQuotedNodeText(transparentExpressionNode(node, tree), tree, content);
}

function opaqueNodeName(
  node: OpaqueParseNode,
  tree: OpaqueParseNode,
  content: string,
): string | undefined {
  if (isOpaqueParseNode(node.argumentExpression)) {
    return staticComputedNodeText(node.argumentExpression, tree, content);
  }
  if (!isOpaqueParseNode(node.name)) {
    return typeof node.text === 'string' ? node.text : undefined;
  }
  if (typeof node.name.text === 'string') return node.name.text;
  if (isOpaqueParseNode(node.name.expression)) {
    return staticComputedNodeText(node.name.expression, tree, content);
  }
  return undefined;
}

function roleWithName(
  role: StaticStringLiteral['role'],
  node: OpaqueParseNode,
  tree: OpaqueParseNode,
  content: string,
): Pick<StaticStringLiteral, 'role' | 'propertyName'> {
  const propertyName = opaqueNodeName(node, tree, content);
  return propertyName ? { role, propertyName } : { role };
}

function initializerLiteralRole(
  parent: OpaqueParseNode,
  tree: OpaqueParseNode,
  content: string,
): Pick<StaticStringLiteral, 'role' | 'propertyName'> {
  const container = isOpaqueParseNode(parent.parent) ? parent.parent : null;
  return container?.properties?.includes(parent)
    ? roleWithName('object-property', parent, tree, content)
    : roleWithName('initializer', parent, tree, content);
}

function isSimpleAssignment(parent: OpaqueParseNode, node: OpaqueParseNode): boolean {
  return (
    parent.right === node &&
    isOpaqueParseNode(parent.left) &&
    isOpaqueParseNode(parent.operatorToken) &&
    parent.operatorToken.getText?.() === '='
  );
}

function transparentWrappedNode(node: OpaqueParseNode): OpaqueParseNode {
  let current = node;
  while (isOpaqueParseNode(current.parent) && current.parent.expression === current) {
    const parentText = current.parent.getText?.().trim() ?? '';
    const isTransparent =
      current.parent.type !== undefined ||
      (parentText.startsWith('(') && parentText.endsWith(')')) ||
      parentText.endsWith('!');
    if (!isTransparent) break;
    current = current.parent;
  }
  return current;
}

function literalRole(
  node: OpaqueParseNode,
  tree: OpaqueParseNode,
  content: string,
): Pick<StaticStringLiteral, 'role' | 'propertyName'> {
  const roleNode = transparentWrappedNode(node);
  if (!isOpaqueParseNode(roleNode.parent)) return { role: 'other' };
  const parent = roleNode.parent;
  if (parent.initializer === roleNode) return initializerLiteralRole(parent, tree, content);
  if (isSimpleAssignment(parent, roleNode) && isOpaqueParseNode(parent.left))
    return roleWithName('assignment', parent.left, tree, content);
  if (parent.elements?.includes(roleNode)) return { role: 'array-element' };
  return { role: 'other' };
}

/**
 * Return real, static quote-delimited string literal nodes from the active
 * TypeScript adapter. The structural role distinguishes object property
 * values from grammatically similar type annotations, labels, and conditional
 * expressions.
 */
export function findStaticStringLiterals(
  filePath: string,
  content: string,
): readonly StaticStringLiteral[] {
  const adapter = currentScope()?.languages.forFile(filePath);
  if (adapter?.id !== 'typescript') return [];
  const tree = getParseTree(adapter, filePath, content);
  if (!isOpaqueParseNode(tree)) return [];

  const literals: StaticStringLiteral[] = [];
  const visit = (node: OpaqueParseNode): void => {
    if (typeof node.text === 'string' && node.getStart && node.getEnd) {
      const start = node.getStart(tree);
      const end = node.getEnd();
      const quote = content[start];
      if ((quote === '"' || quote === "'" || quote === '`') && content[end - 1] === quote) {
        literals.push({
          value: node.text,
          start,
          end,
          ...literalRole(node, tree, content),
        });
      }
    }
    for (const child of node.getChildren?.(tree) ?? []) {
      if (isOpaqueParseNode(child)) visit(child);
    }
  };
  visit(tree);
  return literals;
}

/**
 * Build a comment/regex/JSX-free view that restores static literal tokens.
 * Match literal-dependent syntax against this view, then validate the match
 * start against `createCodeMask()` so examples nested inside another literal
 * still cannot count as executable code.
 */
export function createLiteralAwareCodeMask(filePath: string, content: string): string {
  const codeMask = createCodeMask(filePath, content);
  const characters = codeMask.split('');
  for (const literal of findStaticStringLiterals(filePath, content)) {
    for (let index = literal.start; index < literal.end; index++) {
      characters[index] = content[index] ?? '';
    }
  }
  return characters.join('');
}

function regexLiteralSpans(content: string, tree: unknown): SourceSpan[] {
  if (!isOpaqueParseNode(tree)) return [];
  const spans: SourceSpan[] = [];
  const visit = (node: OpaqueParseNode): void => {
    const children = node.getChildren?.(tree) ?? [];
    if (children.length === 0 && typeof node.text === 'string' && node.getStart && node.getEnd) {
      const start = node.getStart(tree);
      const end = node.getEnd();
      const source = content.slice(start, end);
      if (source.startsWith('/') && source.lastIndexOf('/') > 0) {
        spans.push({ start, end: start + source.lastIndexOf('/') + 1 });
      }
    }
    for (const child of children) {
      if (isOpaqueParseNode(child)) visit(child);
    }
  };
  visit(tree);
  return spans;
}

function jsxTextSpans(tree: unknown): SourceSpan[] {
  if (!isOpaqueParseNode(tree)) return [];
  const spans: SourceSpan[] = [];
  const visit = (node: OpaqueParseNode): void => {
    if (typeof node.containsOnlyTriviaWhiteSpaces === 'boolean' && node.getStart && node.getEnd) {
      spans.push({ start: node.getStart(tree), end: node.getEnd() });
    }
    for (const child of node.getChildren?.(tree) ?? []) {
      if (isOpaqueParseNode(child)) visit(child);
    }
  };
  visit(tree);
  return spans;
}

function stripAstNonCodeSpans(content: string, codeMask: string, tree: unknown): string {
  const characters = codeMask.split('');
  const spans = [
    ...regexLiteralSpans(content, tree).map((span) => ({
      start: span.start + 1,
      end: span.end - 1,
    })),
    ...jsxTextSpans(tree),
  ];
  for (const span of spans) {
    for (let cursor = span.start; cursor < span.end; cursor++) {
      if (characters[cursor] !== '\n') characters[cursor] = ' ';
    }
  }
  return characters.join('');
}

interface TemplateExpressionState {
  readonly index: number;
  readonly depth: number;
  readonly rawStart: number;
}

function advanceTemplateExpression(
  codeMask: string,
  state: TemplateExpressionState,
): TemplateExpressionState {
  const character = codeMask[state.index];
  if (character === '{') {
    return { ...state, index: state.index + 1, depth: state.depth + 1 };
  }
  if (character === '}') {
    const depth = state.depth - 1;
    return {
      index: state.index + 1,
      depth,
      rawStart: depth === 0 ? state.index + 1 : state.rawStart,
    };
  }
  return { ...state, index: state.index + 1 };
}

/**
 * Return the raw-text fragments of a template literal while excluding
 * `${...}` expression source. The code mask preserves template delimiters and
 * executable interpolation braces while blanking raw literal text, strings,
 * and comments inside expressions.
 */
export function templateRawSpans(
  content: string,
  codeMask: string,
  openingBacktick: number,
): readonly SourceSpan[] {
  if (codeMask[openingBacktick] !== '`') {
    const closingBacktick = sourceQuoteEnd(content, openingBacktick, content.length);
    if (
      closingBacktick === -1 ||
      content.slice(openingBacktick + 1, closingBacktick).includes('${')
    ) {
      return [];
    }
    return [{ start: openingBacktick + 1, end: closingBacktick }];
  }

  const spans: SourceSpan[] = [];
  let state: TemplateExpressionState = {
    index: openingBacktick + 1,
    depth: 0,
    rawStart: openingBacktick + 1,
  };

  while (state.index < content.length) {
    const codeCharacter = codeMask[state.index];
    const nextCodeCharacter = codeMask[state.index + 1];

    if (state.depth === 0) {
      if (codeCharacter === '$' && nextCodeCharacter === '{') {
        spans.push({ start: state.rawStart, end: state.index });
        state = { ...state, index: state.index + 2, depth: 1 };
      } else if (codeCharacter === '`') {
        spans.push({ start: state.rawStart, end: state.index });
        return spans;
      } else {
        state = { ...state, index: state.index + 1 };
      }
      continue;
    }

    state = advanceTemplateExpression(codeMask, state);
  }

  return spans;
}

function sourceQuoteEnd(content: string, quoteStart: number, end: number): number {
  const quote = content[quoteStart];
  let escaped = false;
  for (let index = quoteStart + 1; index < end; index++) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (content[index] === '\\') {
      escaped = true;
      continue;
    }
    if (content[index] === quote) return index;
  }
  return -1;
}

interface ImportBindingMetadata {
  readonly runtimeImport: boolean;
  readonly runtimeNamedBindingCount: number;
  readonly runtimeBindingNames: readonly string[];
  readonly namespaceImport: boolean;
}

const NON_RUNTIME_IMPORT_BINDINGS: ImportBindingMetadata = {
  runtimeImport: false,
  runtimeNamedBindingCount: 0,
  runtimeBindingNames: [],
  namespaceImport: false,
};

function nodeText(node: unknown): string | undefined {
  return isOpaqueParseNode(node) && typeof node.text === 'string' ? node.text : undefined;
}

function importBindingMetadata(importClause: unknown): ImportBindingMetadata {
  if (!isOpaqueParseNode(importClause)) {
    return {
      runtimeImport: true,
      runtimeNamedBindingCount: 0,
      runtimeBindingNames: [],
      namespaceImport: false,
    };
  }

  if (importClause.isTypeOnly === true) {
    return {
      runtimeImport: false,
      runtimeNamedBindingCount: 0,
      runtimeBindingNames: [],
      namespaceImport: false,
    };
  }

  const bindingNames: string[] = [];
  const defaultBinding = nodeText(importClause.name);
  if (defaultBinding) bindingNames.push(defaultBinding);

  const namedBindings = isOpaqueParseNode(importClause.namedBindings)
    ? importClause.namedBindings
    : null;
  const namespaceBinding = nodeText(namedBindings?.name);
  if (namespaceBinding) bindingNames.push(namespaceBinding);
  const hasEmptyNamedImports = namedBindings?.elements?.length === 0;

  let runtimeNamedBindingCount = 0;
  for (const element of namedBindings?.elements ?? []) {
    if (!isOpaqueParseNode(element) || element.isTypeOnly === true) continue;
    runtimeNamedBindingCount++;
    const importedName = nodeText(element.propertyName);
    const localName = nodeText(element.name);
    if (importedName) bindingNames.push(importedName);
    if (localName) bindingNames.push(localName);
  }

  return {
    runtimeImport:
      defaultBinding !== undefined ||
      namespaceBinding !== undefined ||
      hasEmptyNamedImports ||
      runtimeNamedBindingCount > 0,
    runtimeNamedBindingCount,
    runtimeBindingNames: [...new Set(bindingNames)],
    namespaceImport: namespaceBinding !== undefined,
  };
}

function staticModuleLiteral(node: OpaqueParseNode): OpaqueParseNode | null {
  if (isOpaqueParseNode(node.moduleSpecifier)) return node.moduleSpecifier;
  if (
    isOpaqueParseNode(node.moduleReference) &&
    isOpaqueParseNode(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression;
  }
  return null;
}

function staticReferenceKeyword(
  content: string,
  index: number,
): StaticModuleReference['keyword'] | null {
  const sourceStart = content.slice(index, index + 6);
  if (sourceStart.startsWith('import')) return 'import';
  if (sourceStart.startsWith('export')) return 'export';
  return null;
}

function staticReferenceBindings(
  keyword: StaticModuleReference['keyword'],
  node: OpaqueParseNode,
  isImportEquals: boolean,
): ImportBindingMetadata {
  if (isImportEquals) {
    const bindingName = nodeText(node.name);
    return {
      runtimeImport: node.isTypeOnly !== true,
      runtimeNamedBindingCount: 0,
      runtimeBindingNames: bindingName ? [bindingName] : [],
      namespaceImport: true,
    };
  }
  return keyword === 'import'
    ? importBindingMetadata(node.importClause)
    : NON_RUNTIME_IMPORT_BINDINGS;
}

function staticModuleReferenceFromNode(
  content: string,
  tree: OpaqueParseNode,
  node: OpaqueParseNode,
): StaticModuleReference | null {
  if (!node.getStart) return null;
  const moduleLiteral = staticModuleLiteral(node);
  const moduleSpecifier = staticQuotedNodeText(moduleLiteral, tree, content, false);
  if (moduleSpecifier === undefined) return null;

  const index = node.getStart(tree);
  const sourceKeyword = staticReferenceKeyword(content, index);
  if (!sourceKeyword) return null;

  const isImportEquals = isOpaqueParseNode(node.moduleReference);
  const keyword = isImportEquals ? 'import' : sourceKeyword;
  const candidateClause = keyword === 'import' ? node.importClause : node.exportClause;
  const clause = isOpaqueParseNode(candidateClause) ? candidateClause : null;
  const bindings = staticReferenceBindings(keyword, node, isImportEquals);
  const importEqualsClause = isImportEquals ? (nodeText(node.name) ?? '') : '';

  return {
    index,
    keyword,
    clauseCode: clause?.getText?.(tree) ?? importEqualsClause,
    moduleSpecifier,
    ...bindings,
  };
}

const SIMPLE_JAVASCRIPT_ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '0': '\0',
};

interface DecodedEscape {
  readonly value: string;
  readonly nextIndex: number;
}

function decodedLegacyOctalEscape(source: string, escapeIndex: number): DecodedEscape | null {
  const firstDigit = source[escapeIndex] ?? '';
  if (!/^[0-7]$/.test(firstDigit)) return null;

  let digits = firstDigit;
  const secondDigit = source[escapeIndex + 1] ?? '';
  if (/^[0-7]$/.test(secondDigit)) {
    digits += secondDigit;
    const thirdDigit = source[escapeIndex + 2] ?? '';
    if (/^[0-3]$/.test(firstDigit) && /^[0-7]$/.test(thirdDigit)) {
      digits += thirdDigit;
    }
  }

  // A bare `\0` is handled by SIMPLE_JAVASCRIPT_ESCAPES. It becomes a
  // legacy octal escape only when followed by another octal digit.
  if (digits === '0') return null;
  return {
    value: String.fromCodePoint(Number.parseInt(digits, 8)),
    nextIndex: escapeIndex + digits.length,
  };
}

function decodedHexEscape(
  source: string,
  digitsStart: number,
  digitsLength: number,
): DecodedEscape | null {
  const digits = source.slice(digitsStart, digitsStart + digitsLength);
  if (!new RegExp(`^[\\dA-Fa-f]{${digitsLength}}$`).test(digits)) return null;
  return {
    value: String.fromCodePoint(Number.parseInt(digits, 16)),
    nextIndex: digitsStart + digitsLength,
  };
}

function decodedUnicodeEscape(source: string, escapeIndex: number): DecodedEscape | null {
  if (source[escapeIndex + 1] !== '{') {
    return decodedHexEscape(source, escapeIndex + 1, 4);
  }

  const closingBrace = source.indexOf('}', escapeIndex + 2);
  const digits = closingBrace === -1 ? '' : source.slice(escapeIndex + 2, closingBrace);
  if (!/^[\dA-Fa-f]{1,6}$/.test(digits)) return null;
  const codePoint = Number.parseInt(digits, 16);
  if (codePoint > 0x10_ff_ff) return null;
  return {
    value: String.fromCodePoint(codePoint),
    nextIndex: closingBrace + 1,
  };
}

function decodeJavaScriptEscape(source: string, escapeIndex: number): DecodedEscape {
  const escaped = source[escapeIndex];
  if (escaped === undefined) return { value: '', nextIndex: source.length };
  const octalEscape = decodedLegacyOctalEscape(source, escapeIndex);
  if (octalEscape) return octalEscape;
  if (escaped in SIMPLE_JAVASCRIPT_ESCAPES) {
    return {
      value: SIMPLE_JAVASCRIPT_ESCAPES[escaped] ?? '',
      nextIndex: escapeIndex + 1,
    };
  }
  if (escaped === '\n') return { value: '', nextIndex: escapeIndex + 1 };
  if (escaped === '\r') {
    const nextIndex = source[escapeIndex + 1] === '\n' ? escapeIndex + 2 : escapeIndex + 1;
    return { value: '', nextIndex };
  }

  let decoded: DecodedEscape | null = null;
  if (escaped === 'x') decoded = decodedHexEscape(source, escapeIndex + 1, 2);
  if (escaped === 'u') decoded = decodedUnicodeEscape(source, escapeIndex);
  return decoded ?? { value: escaped, nextIndex: escapeIndex + 1 };
}

export interface DecodedJavaScriptStaticText {
  readonly text: string;
  /**
   * Source offset for each UTF-16 code unit in `text`. Escapes that emit
   * multiple code units map each unit to the escape's opening backslash;
   * line-continuation escapes emit no entry.
   */
  readonly rawOffsets: readonly number[];
}

export function decodeJavaScriptStaticTextWithOffsets(value: string): DecodedJavaScriptStaticText {
  let text = '';
  const rawOffsets: number[] = [];
  let index = 0;
  while (index < value.length) {
    const character = value[index] ?? '';
    if (character !== '\\') {
      text += character;
      rawOffsets.push(index);
      index++;
      continue;
    }

    const escapeStart = index;
    const escape = decodeJavaScriptEscape(value, index + 1);
    text += escape.value;
    rawOffsets.push(...escape.value.split('').map(() => escapeStart));
    index = escape.nextIndex;
  }
  return { text, rawOffsets };
}

export function decodeJavaScriptStaticText(value: string): string {
  return decodeJavaScriptStaticTextWithOffsets(value).text;
}

function isFallbackTypeOnlyBinding(binding: string): boolean {
  if (!/^type\b/.test(binding)) return false;
  const afterType = binding.slice('type'.length).trim();
  return afterType.length > 0 && !/^as\b/.test(afterType);
}

function fallbackImportBindingMetadata(clauseCode: string): ImportBindingMetadata {
  const trimmed = clauseCode.trim();
  const afterType = /^type\b/.test(trimmed) ? trimmed.slice('type'.length).trim() : '';
  if (afterType.length > 0 && !afterType.startsWith(',')) {
    return {
      runtimeImport: false,
      runtimeNamedBindingCount: 0,
      runtimeBindingNames: [],
      namespaceImport: false,
    };
  }

  const bindingNames: string[] = [];
  const namespaceMatch = /\*\s+as\s+([\w$]+)/.exec(trimmed);
  if (namespaceMatch?.[1]) bindingNames.push(namespaceMatch[1]);
  const namedBody = /\{([^}]*)\}/.exec(trimmed)?.[1];
  const runtimeNamedBindings =
    namedBody
      ?.split(',')
      .map((binding) => binding.trim())
      .filter((binding) => binding.length > 0 && !isFallbackTypeOnlyBinding(binding)) ?? [];
  for (const binding of runtimeNamedBindings) {
    for (const name of binding.split(/\s+as\s+/)) {
      if (name) bindingNames.push(name);
    }
  }

  const braceIndex = trimmed.indexOf('{');
  const starIndex = trimmed.indexOf('*');
  let prefixEnd = trimmed.length;
  if (braceIndex >= 0) prefixEnd = Math.min(prefixEnd, braceIndex);
  if (starIndex >= 0) prefixEnd = Math.min(prefixEnd, starIndex);
  const defaultBinding = trimmed.slice(0, prefixEnd).replace(/,\s*$/, '').trim();
  if (defaultBinding) bindingNames.push(defaultBinding);
  const hasEmptyNamedImports = namedBody?.trim().length === 0;

  return {
    runtimeImport:
      trimmed.length === 0 ||
      defaultBinding.length > 0 ||
      namespaceMatch !== null ||
      hasEmptyNamedImports ||
      runtimeNamedBindings.length > 0,
    runtimeNamedBindingCount: runtimeNamedBindings.length,
    runtimeBindingNames: [...new Set(bindingNames)],
    namespaceImport: namespaceMatch !== null,
  };
}

function skipSourceTrivia(content: string, fromIndex: number, end: number): number {
  let index = fromIndex;
  while (index < end) {
    if (/\s/.test(content[index] ?? '')) {
      index++;
      continue;
    }
    if (content.startsWith('//', index)) {
      const newline = content.indexOf('\n', index + 2);
      index = newline === -1 ? end : newline + 1;
      continue;
    }
    if (content.startsWith('/*', index)) {
      const closing = content.indexOf('*/', index + 2);
      if (closing === -1) return end;
      index = closing + 2;
      continue;
    }
    return index;
  }
  return end;
}

interface FallbackSourceClause {
  readonly quoteStart: number;
  readonly clauseCode: string;
}

interface FallbackImportEqualsClause extends FallbackSourceClause {
  readonly bindingName: string;
}

function sourceIdentifierAt(
  content: string,
  fromIndex: number,
  end: number,
): { readonly name: string; readonly end: number } | null {
  const match = /^[$A-Z_a-z][$\w]*/.exec(content.slice(fromIndex, end));
  return match
    ? {
        name: match[0],
        end: fromIndex + match[0].length,
      }
    : null;
}

function sourceTokenEnd(
  content: string,
  fromIndex: number,
  end: number,
  token: string,
): number | null {
  const index = skipSourceTrivia(content, fromIndex, end);
  if (
    !content.startsWith(token, index) ||
    (/[$\w]/.test(token.at(-1) ?? '') && /[$\w]/.test(content[index + token.length] ?? ''))
  ) {
    return null;
  }
  return index + token.length;
}

function fallbackImportEqualsClause(
  keyword: StaticModuleReference['keyword'],
  content: string,
  afterKeyword: number,
  end: number,
): FallbackImportEqualsClause | null {
  let cursor = afterKeyword;
  if (keyword === 'export') {
    const importEnd = sourceTokenEnd(content, cursor, end, 'import');
    if (importEnd === null) return null;
    cursor = importEnd;
  }

  cursor = skipSourceTrivia(content, cursor, end);
  const binding = sourceIdentifierAt(content, cursor, end);
  if (!binding) return null;
  cursor = binding.end;

  const equalsEnd = sourceTokenEnd(content, cursor, end, '=');
  if (equalsEnd === null) return null;
  const requireEnd = sourceTokenEnd(content, equalsEnd, end, 'require');
  if (requireEnd === null) return null;
  const openParenthesisEnd = sourceTokenEnd(content, requireEnd, end, '(');
  if (openParenthesisEnd === null) return null;
  const quoteStart = skipSourceTrivia(content, openParenthesisEnd, end);
  if (!/['"]/.test(content[quoteStart] ?? '')) return null;

  return {
    bindingName: binding.name,
    clauseCode: binding.name,
    quoteStart,
  };
}

function previousSourceWord(content: string, beforeIndex: number): string {
  let end = beforeIndex;
  while (end > 0 && /\s/.test(content[end - 1] ?? '')) end--;
  let start = end;
  while (start > 0 && /[$\w]/.test(content[start - 1] ?? '')) start--;
  return content.slice(start, end);
}

function wordBeforeMatchingParenthesis(content: string, closeIndex: number): string {
  let depth = 1;
  for (let index = closeIndex - 1; index >= 0; index--) {
    if (content[index] === ')') depth++;
    if (content[index] !== '(') continue;
    depth--;
    if (depth === 0) return previousSourceWord(content, index);
  }
  return '';
}

function canStartFallbackRegexLiteral(content: string, slashIndex: number): boolean {
  let previous = slashIndex - 1;
  while (previous >= 0 && /\s/.test(content[previous] ?? '')) previous--;
  if (previous < 0) return true;

  const character = content[previous] ?? '';
  if (/[[{:,(;=!?&|+\-*%^~<>]/.test(character) || character === '}') return true;
  if (
    character === ')' &&
    /^(?:for|if|while|with)$/.test(wordBeforeMatchingParenthesis(content, previous))
  ) {
    return true;
  }
  return /^(?:await|case|delete|do|else|in|instanceof|new|of|return|throw|typeof|void|yield)$/.test(
    previousSourceWord(content, previous + 1),
  );
}

function fallbackRegexEnd(content: string, slashIndex: number): number {
  let escaped = false;
  let inCharacterClass = false;
  for (let cursor = slashIndex + 1; cursor < content.length; cursor++) {
    const character = content[cursor] ?? '';
    if (character === '\n') return -1;
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '[') {
      inCharacterClass = true;
    } else if (character === ']') {
      inCharacterClass = false;
    } else if (character === '/' && !inCharacterClass) {
      return cursor;
    }
  }
  return -1;
}

function insideFallbackRegexLiteral(content: string, targetIndex: number): boolean {
  const lineStart = content.lastIndexOf('\n', targetIndex - 1) + 1;
  let index = lineStart;
  while (index < targetIndex) {
    if (content[index] !== '/' || !canStartFallbackRegexLiteral(content, index)) {
      index++;
      continue;
    }

    const regexEnd = fallbackRegexEnd(content, index);
    if (regexEnd !== -1 && targetIndex < regexEnd) return true;
    index = regexEnd === -1 ? index + 1 : regexEnd + 1;
  }
  return false;
}

function fallbackSourceClause(
  keyword: StaticModuleReference['keyword'],
  content: string,
  codeMask: string,
  afterKeyword: number,
  end: number,
): FallbackSourceClause | null {
  const firstToken = skipSourceTrivia(content, afterKeyword, end);
  if (keyword === 'import' && /['"]/.test(content[firstToken] ?? '')) {
    return { quoteStart: firstToken, clauseCode: '' };
  }

  const statementMask = codeMask.slice(afterKeyword, end);
  for (const fromMatch of statementMask.matchAll(/\bfrom\b/g)) {
    if (fromMatch.index === undefined) continue;
    const afterFrom = afterKeyword + fromMatch.index + fromMatch[0].length;
    const candidate = skipSourceTrivia(content, afterFrom, end);
    if (!/['"]/.test(content[candidate] ?? '')) continue;
    return {
      quoteStart: candidate,
      clauseCode: codeMask.slice(afterKeyword, afterKeyword + fromMatch.index),
    };
  }
  return null;
}

function fallbackStaticModuleReference(
  content: string,
  codeMask: string,
  match: RegExpMatchArray,
  end: number,
): StaticModuleReference | null {
  const sourceKeyword = match[2];
  if (match.index === undefined || (sourceKeyword !== 'import' && sourceKeyword !== 'export')) {
    return null;
  }
  const keywordIndex = match.index + match[0].lastIndexOf(sourceKeyword);
  if (insideFallbackRegexLiteral(codeMask, keywordIndex)) return null;
  const afterKeyword = keywordIndex + sourceKeyword.length;
  if (/^\s*[.(]/.test(codeMask.slice(afterKeyword, end))) return null;

  const importEquals = fallbackImportEqualsClause(sourceKeyword, content, afterKeyword, end);
  const sourceClause =
    importEquals ?? fallbackSourceClause(sourceKeyword, content, codeMask, afterKeyword, end);
  if (!sourceClause) return null;
  const quoteEnd = sourceQuoteEnd(content, sourceClause.quoteStart, end);
  if (quoteEnd === -1) return null;

  if (importEquals) {
    const closeParenthesis = skipSourceTrivia(content, quoteEnd + 1, end);
    if (content[closeParenthesis] !== ')') return null;
    const lineEnd = content.indexOf('\n', closeParenthesis + 1);
    const suffixEnd = lineEnd === -1 ? end : Math.min(lineEnd, end);
    const suffixStart = skipSourceTrivia(content, closeParenthesis + 1, suffixEnd);
    if (suffixStart < suffixEnd && content[suffixStart] !== ';') return null;
    return {
      index: keywordIndex,
      keyword: 'import',
      clauseCode: importEquals.clauseCode,
      moduleSpecifier: decodeJavaScriptStaticText(
        content.slice(sourceClause.quoteStart + 1, quoteEnd),
      ),
      runtimeImport: true,
      runtimeNamedBindingCount: 0,
      runtimeBindingNames: [importEquals.bindingName],
      namespaceImport: true,
    };
  }

  const bindings: ImportBindingMetadata =
    sourceKeyword === 'import'
      ? fallbackImportBindingMetadata(sourceClause.clauseCode)
      : {
          runtimeImport: false,
          runtimeNamedBindingCount: 0,
          runtimeBindingNames: [],
          namespaceImport: false,
        };
  return {
    index: keywordIndex,
    keyword: sourceKeyword,
    clauseCode: sourceClause.clauseCode,
    moduleSpecifier: decodeJavaScriptStaticText(
      content.slice(sourceClause.quoteStart + 1, quoteEnd),
    ),
    ...bindings,
  };
}

function fallbackStaticModuleReferences(
  filePath: string,
  content: string,
): readonly StaticModuleReference[] {
  const codeMask = createCodeMask(filePath, content);
  const declarations = [...codeMask.matchAll(/(^|[;}])[\t ]*(import|export)\b/gm)];
  const references: StaticModuleReference[] = [];

  for (const [declarationIndex, match] of declarations.entries()) {
    const end = declarations[declarationIndex + 1]?.index ?? content.length;
    const reference = fallbackStaticModuleReference(content, codeMask, match, end);
    if (reference) references.push(reference);
  }

  return references;
}

/**
 * Extract static `import ... from`, side-effect `import "..."`, and
 * `export ... from` declarations from the TypeScript syntax tree. Structural
 * statement boundaries avoid associating contextual `import`/`export` tokens
 * with a later declaration, and the parser supplies cooked module values.
 */
export function findStaticModuleReferences(
  filePath: string,
  content: string,
): readonly StaticModuleReference[] {
  const adapter = currentScope()?.languages.forFile(filePath);
  if (adapter?.id !== 'typescript') return fallbackStaticModuleReferences(filePath, content);
  const tree = getParseTree(adapter, filePath, content);
  if (!isOpaqueParseNode(tree)) return [];

  const references: StaticModuleReference[] = [];
  const visit = (node: OpaqueParseNode): void => {
    const reference = staticModuleReferenceFromNode(content, tree, node);
    if (reference) references.push(reference);
    for (const child of node.getChildren?.(tree) ?? []) {
      if (isOpaqueParseNode(child)) visit(child);
    }
  };

  visit(tree);
  return references;
}

/**
 * Return opening-backtick offsets for templates tagged by a specific
 * identifier. Type arguments belong to the tagged-template node rather than
 * the tag expression, so `gql<Result>\`...\`` resolves to the same `gql` tag.
 */
export function findTaggedTemplateStarts(
  filePath: string,
  content: string,
  tagName: string,
): readonly number[] {
  const adapter = currentScope()?.languages.forFile(filePath);
  if (adapter?.id !== 'typescript') return [];
  const tree = getParseTree(adapter, filePath, content);
  if (!isOpaqueParseNode(tree)) return [];

  const starts: number[] = [];
  const visit = (node: OpaqueParseNode): void => {
    if (
      isOpaqueParseNode(node.tag) &&
      isOpaqueParseNode(node.template) &&
      node.tag.getText?.(tree) === tagName &&
      node.template.getStart &&
      node.template.getEnd
    ) {
      const templateStart = node.template.getStart(tree);
      const templateEnd = node.template.getEnd();
      const openingBacktick = content.indexOf('`', templateStart);
      if (openingBacktick >= templateStart && openingBacktick < templateEnd) {
        starts.push(openingBacktick);
      }
    }
    for (const child of node.getChildren?.(tree) ?? []) {
      if (isOpaqueParseNode(child)) visit(child);
    }
  };

  visit(tree);
  return starts;
}

function patternForIteration(pattern: RegExp): RegExp {
  const flags = pattern.flags.replace('y', '');
  return new RegExp(pattern.source, flags.includes('g') ? flags : `${flags}g`);
}

/**
 * Return the first match whose first non-whitespace character is source code.
 * The returned index is relative to `content`, just like RegExp.exec().
 */
export function findCodeMatches(
  pattern: RegExp,
  content: string,
  codeMask: string,
): RegExpExecArray[] {
  const candidatePattern = patternForIteration(pattern);
  const matches: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;

  while ((match = candidatePattern.exec(content)) !== null) {
    const firstTokenOffset = match[0].search(/\S/);
    const tokenIndex = match.index + Math.max(0, firstTokenOffset);
    if (codeMask[tokenIndex] !== undefined && !/\s/.test(codeMask[tokenIndex])) {
      matches.push(match);
    }

    if (match[0].length === 0) candidatePattern.lastIndex++;
  }

  return matches;
}

export function findCodeMatch(
  pattern: RegExp,
  content: string,
  codeMask: string,
): RegExpExecArray | null {
  return findCodeMatches(pattern, content, codeMask)[0] ?? null;
}

export function hasCodeMatch(pattern: RegExp, content: string, codeMask: string): boolean {
  return findCodeMatch(pattern, content, codeMask) !== null;
}

function isIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\w$]/.test(character);
}

export function hasCodeIdentifier(content: string, codeMask: string, identifier: string): boolean {
  let fromIndex = 0;
  while (fromIndex < content.length) {
    const index = content.indexOf(identifier, fromIndex);
    if (index === -1) return false;

    const before = content[index - 1];
    const after = content[index + identifier.length];
    const startsInCode = codeMask[index] !== undefined && !/\s/.test(codeMask[index] ?? ' ');
    if (startsInCode && !isIdentifierCharacter(before) && !isIdentifierCharacter(after)) {
      return true;
    }
    fromIndex = index + identifier.length;
  }
  return false;
}
