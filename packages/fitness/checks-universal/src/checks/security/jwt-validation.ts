/**
 * @fileoverview Validate JWT handling follows security best practices
 */

import { currentScope, getParseTree, logger } from '@opensip-cli/core';
import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

import {
  createCodeMask,
  findStaticStringLiterals,
  type StaticStringLiteral,
} from '../code-aware-match.js';

/**
 * JWT security pattern definitions.
 * Each pattern has a check function to avoid complex regex backtracking issues.
 */
interface JwtMatch {
  readonly matchIndex: number;
  readonly matchText: string;
}

interface JwtSecurityPattern {
  id: string;
  message: string;
  suggestion: string;
  severity: 'error' | 'warning';
  check?: (line: string, codeLine: string) => readonly JwtMatch[];
}

function startsInCode(code: string, index: number): boolean {
  return code[index] !== undefined && !/\s/.test(code[index] ?? ' ');
}

/**
 * Check if line uses jwt.decode for authentication context.
 *
 * @param line - Line to check
 * @returns Match result
 */
function checkJwtDecodeForAuth(_line: string, codeLine: string): readonly JwtMatch[] {
  logger.debug({
    evt: 'fitness.checks.jwt_validation.check_jwt_decode_for_auth',
    msg: 'Checking for JWT decode used for authentication',
  });
  const idx = codeLine.indexOf('jwt.decode');
  if (idx === -1) return [];

  // Check if line contains auth-related keywords
  const lowerLine = codeLine.toLowerCase();
  const authKeywords = ['user', 'auth', 'session', 'token'];
  const hasAuthKeyword = authKeywords.some((kw) => lowerLine.includes(kw));

  if (hasAuthKeyword) {
    return [{ matchIndex: idx, matchText: 'jwt.decode' }];
  }

  return [];
}

/* v8 ignore start -- secret-detection helpers iterate keywords and apply regex; covered indirectly via fixtures */
/**
 * Check if line has a weak JWT secret (short string literal).
 *
 * @param line - Line to check
 * @returns Match result
 */
function checkWeakJwtSecret(line: string, codeLine: string): readonly JwtMatch[] {
  logger.debug({
    evt: 'fitness.checks.jwt_validation.check_weak_jwt_secret',
    msg: 'Checking for weak JWT secret',
  });
  const matches: JwtMatch[] = [];
  const secretPattern = /\b(?:jwtsecret|jwt_secret|jwt-secret|secret)\b/gi;

  for (const keywordMatch of line.matchAll(secretPattern)) {
    if (keywordMatch.index === undefined || !startsInCode(codeLine, keywordMatch.index)) continue;
    const afterKeywordIndex = keywordMatch.index + keywordMatch[0].length;
    const afterKeyword = line.slice(afterKeywordIndex);
    // Match patterns like: = 'short' or : "short"
    // @fitness-ignore-next-line sonarjs-regular-expr -- Simple pattern with bounded quantifier {0,20} and negated class [^'"`]; no backtracking risk
    const assignMatch = /^\s*([:=])\s*(['"`])([^'"`]{0,20})\2/.exec(afterKeyword);
    if (assignMatch?.[3] === undefined) continue;
    const separatorIndex = afterKeywordIndex + assignMatch[0].indexOf(assignMatch[1] ?? '');
    const quoteIndex = afterKeywordIndex + assignMatch[0].indexOf(assignMatch[2] ?? '');
    if (!startsInCode(codeLine, separatorIndex) || !startsInCode(codeLine, quoteIndex)) continue;
    matches.push({
      matchIndex: keywordMatch.index,
      matchText: keywordMatch[0] + assignMatch[0],
    });
  }

  return matches;
}
/* v8 ignore stop */

const JWT_SECURITY_PATTERNS: JwtSecurityPattern[] = [
  {
    // @fitness-ignore-next-line fitness-check-standards -- This is an internal pattern ID for violation grouping, not the check ID
    id: 'jwt-verify-no-algorithm',
    message: 'JWT verification without algorithm restriction - specify algorithms option',
    suggestion:
      'Add algorithms option to prevent algorithm substitution attacks: jwt.verify(token, secret, { algorithms: ["HS256"] }). This ensures only the expected algorithm is accepted.',
    severity: 'error',
  },
  {
    id: 'jwt-decode-for-auth',
    message: 'jwt.decode used for authentication - use jwt.verify instead',
    suggestion:
      'jwt.decode does not verify the signature! Use jwt.verify() for authentication: const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });',
    severity: 'error',
    check: checkJwtDecodeForAuth,
  },
  {
    id: 'weak-jwt-secret',
    message: 'JWT secret appears weak (too short) - use a strong random secret',
    suggestion:
      'Use a cryptographically strong random secret of at least 256 bits (32 bytes). Generate with: openssl rand -base64 32. Store in environment variable, not in code.',
    severity: 'warning',
    check: checkWeakJwtSecret,
  },
  {
    id: 'algorithm-none',
    message: 'JWT algorithm "none" is insecure - never allow unsigned tokens',
    suggestion:
      'Remove "none" from allowed algorithms. This would allow unsigned tokens to bypass authentication. Use only secure algorithms like HS256, RS256, or ES256.',
    severity: 'error',
  },
  {
    id: 'missing-issuer-audience',
    message: 'Consider adding issuer/audience validation for enhanced security',
    suggestion:
      'Add issuer and audience validation: jwt.verify(token, secret, { issuer: "your-issuer", audience: "your-api" }). This prevents token reuse across different services.',
    severity: 'warning',
  },
];
const FILE_LEVEL_PATTERN_IDS = new Set([
  'jwt-verify-no-algorithm',
  'algorithm-none',
  'missing-issuer-audience',
]);

interface OpaqueJwtNode {
  readonly text?: unknown;
  readonly expression?: unknown;
  readonly name?: unknown;
  readonly argumentExpression?: unknown;
  readonly initializer?: unknown;
  readonly left?: unknown;
  readonly right?: unknown;
  readonly operatorToken?: unknown;
  readonly type?: unknown;
  readonly arguments?: readonly unknown[];
  readonly elements?: readonly unknown[];
  readonly properties?: readonly unknown[];
  readonly getStart?: (sourceFile?: unknown) => number;
  readonly getEnd?: () => number;
  readonly getText?: (sourceFile?: unknown) => string;
  readonly getChildren?: (sourceFile?: unknown) => readonly unknown[];
  readonly getLineAndCharacterOfPosition?: (position: number) => {
    readonly line: number;
    readonly character: number;
  };
}

interface VerifyCall {
  readonly call: OpaqueJwtNode;
  readonly member: OpaqueJwtNode;
  readonly arguments: readonly unknown[];
}

interface AlgorithmArray {
  readonly nameNode: OpaqueJwtNode;
  readonly arrayNode: OpaqueJwtNode;
}

function isOpaqueJwtNode(value: unknown): value is OpaqueJwtNode {
  return typeof value === 'object' && value !== null;
}

function sourceText(node: OpaqueJwtNode, tree: OpaqueJwtNode): string {
  return node.getText?.(tree).trim() ?? '';
}

function unwrapTransparentExpression(candidate: OpaqueJwtNode, tree: OpaqueJwtNode): OpaqueJwtNode {
  let node = candidate;
  while (isOpaqueJwtNode(node.expression)) {
    const text = sourceText(node, tree);
    const transparent =
      node.type !== undefined || (text.startsWith('(') && text.endsWith(')')) || text.endsWith('!');
    if (!transparent) break;
    node = node.expression;
  }
  return node;
}

function staticStringValue(
  candidate: unknown,
  tree: OpaqueJwtNode,
  content: string,
): string | undefined {
  if (!isOpaqueJwtNode(candidate) || typeof candidate.text !== 'string') return undefined;
  const start = candidate.getStart?.(tree);
  const end = candidate.getEnd?.();
  if (start === undefined || end === undefined) return undefined;
  const quote = content[start];
  return (quote === '"' || quote === "'" || quote === '`') && content[end - 1] === quote
    ? candidate.text
    : undefined;
}

function staticNameNode(
  candidate: unknown,
  tree: OpaqueJwtNode,
  content: string,
): string | undefined {
  if (!isOpaqueJwtNode(candidate)) return undefined;
  if (isOpaqueJwtNode(candidate.expression)) {
    return staticStringValue(candidate.expression, tree, content);
  }
  return typeof candidate.text === 'string' ? candidate.text : undefined;
}

function staticMemberName(
  node: OpaqueJwtNode,
  tree: OpaqueJwtNode,
  content: string,
): string | undefined {
  if (isOpaqueJwtNode(node.argumentExpression)) {
    return staticStringValue(node.argumentExpression, tree, content);
  }
  return staticNameNode(node.name, tree, content);
}

function verifyCallFromNode(
  node: OpaqueJwtNode,
  tree: OpaqueJwtNode,
  content: string,
): VerifyCall | null {
  if (!Array.isArray(node.arguments) || !isOpaqueJwtNode(node.expression)) return null;
  if (/^new\b/.test(sourceText(node, tree))) return null;
  const member = unwrapTransparentExpression(node.expression, tree);
  if (
    staticMemberName(member, tree, content)?.toLowerCase() !== 'verify' ||
    !isOpaqueJwtNode(member.expression)
  ) {
    return null;
  }
  return { call: node, member, arguments: node.arguments };
}

function isJwtReceiver(call: VerifyCall, tree: OpaqueJwtNode): boolean {
  const receiver = unwrapTransparentExpression(call.member.expression as OpaqueJwtNode, tree);
  return receiver.text === 'jwt' && sourceText(receiver, tree) === 'jwt';
}

function inlineOptionsObject(
  candidate: unknown,
  tree: OpaqueJwtNode,
  content: string,
): OpaqueJwtNode | null {
  if (!isOpaqueJwtNode(candidate)) return null;
  const node = unwrapTransparentExpression(candidate, tree);
  const start = node.getStart?.(tree);
  return Array.isArray(node.properties) && start !== undefined && content[start] === '{'
    ? node
    : null;
}

function hasTopLevelIssuerOrAudience(
  options: OpaqueJwtNode,
  tree: OpaqueJwtNode,
  content: string,
): boolean {
  return (options.properties ?? []).some(
    (property) =>
      isOpaqueJwtNode(property) &&
      /^(?:issuer|audience|iss|aud)$/i.test(staticNameNode(property.name, tree, content) ?? ''),
  );
}

function arrayLiteralNode(
  candidate: unknown,
  tree: OpaqueJwtNode,
  content: string,
): OpaqueJwtNode | null {
  if (!isOpaqueJwtNode(candidate)) return null;
  const node = unwrapTransparentExpression(candidate, tree);
  const start = node.getStart?.(tree);
  return Array.isArray(node.elements) && start !== undefined && content[start] === '['
    ? node
    : null;
}

function algorithmCarrierName(
  candidate: OpaqueJwtNode,
  tree: OpaqueJwtNode,
  content: string,
): { readonly name: string; readonly node: OpaqueJwtNode } | null {
  if (isOpaqueJwtNode(candidate.name)) {
    const name = staticNameNode(candidate.name, tree, content);
    return name ? { name, node: candidate.name } : null;
  }
  const memberName = staticMemberName(candidate, tree, content);
  if (memberName) return { name: memberName, node: candidate };
  return typeof candidate.text === 'string' ? { name: candidate.text, node: candidate } : null;
}

function algorithmArrayFromNode(
  node: OpaqueJwtNode,
  tree: OpaqueJwtNode,
  content: string,
): AlgorithmArray | null {
  let value: unknown;
  let carrier: { readonly name: string; readonly node: OpaqueJwtNode } | null = null;
  if (node.initializer !== undefined) {
    value = node.initializer;
    carrier = algorithmCarrierName(node, tree, content);
  } else if (
    isOpaqueJwtNode(node.left) &&
    isOpaqueJwtNode(node.operatorToken) &&
    node.operatorToken.getText?.(tree) === '='
  ) {
    value = node.right;
    carrier = algorithmCarrierName(node.left, tree, content);
  }
  if (!carrier) return null;
  if (!/^[\w$]*algorithms?[\w$]*$/i.test(carrier.name)) return null;
  const arrayNode = arrayLiteralNode(value, tree, content);
  return arrayNode ? { nameNode: carrier.node, arrayNode } : null;
}

function containsNoneLiteral(array: OpaqueJwtNode, tree: OpaqueJwtNode, content: string): boolean {
  return (array.elements ?? []).some((element) => {
    if (!isOpaqueJwtNode(element)) return false;
    const literal = unwrapTransparentExpression(element, tree);
    return staticStringValue(literal, tree, content)?.toLowerCase() === 'none';
  });
}

function structuralViolation(
  patternId: string,
  start: number,
  end: number,
  content: string,
  filePath: string,
  tree?: OpaqueJwtNode,
): CheckViolation[] {
  const pattern = JWT_SECURITY_PATTERNS.find((candidate) => candidate.id === patternId);
  if (!pattern) return [];
  const location = tree?.getLineAndCharacterOfPosition?.(start);
  const lineStart = content.lastIndexOf('\n', start - 1) + 1;
  return [
    {
      line: (location?.line ?? content.slice(0, start).split('\n').length - 1) + 1,
      column: location?.character ?? start - lineStart,
      message: pattern.message,
      severity: pattern.severity,
      suggestion: pattern.suggestion,
      match: content.slice(start, end),
      filePath,
    },
  ];
}

function nodeSpan(node: OpaqueJwtNode, tree: OpaqueJwtNode): { start: number; end: number } | null {
  const start = node.getStart?.(tree);
  const end = node.getEnd?.();
  return start === undefined || end === undefined ? null : { start, end };
}

function closingFallbackCall(codeMask: string, openingParenthesis: number): number {
  let depth = 0;
  for (let index = openingParenthesis; index < codeMask.length; index++) {
    if (codeMask[index] === '(') depth++;
    if (codeMask[index] !== ')') continue;
    depth--;
    if (depth === 0) return index;
  }
  return -1;
}

function fallbackArgumentCount(
  content: string,
  codeMask: string,
  openingParenthesis: number,
  closingParenthesis: number,
): number {
  const boundaries = [openingParenthesis + 1];
  let parentheses = 1;
  let brackets = 0;
  let braces = 0;
  for (let index = openingParenthesis + 1; index < closingParenthesis; index++) {
    const character = codeMask[index];
    if (character === '(') parentheses++;
    else if (character === ')') parentheses--;
    else if (character === '[') brackets++;
    else if (character === ']') brackets--;
    else if (character === '{') braces++;
    else if (character === '}') braces--;
    else if (character === ',' && parentheses === 1 && brackets === 0 && braces === 0) {
      boundaries.push(index + 1);
    }
  }
  boundaries.push(closingParenthesis + 1);
  return boundaries.slice(0, -1).filter((start, index) => {
    const end = (boundaries[index + 1] ?? closingParenthesis + 1) - 1;
    return content.slice(start, end).trim().length > 0;
  }).length;
}

function fallbackJwtFileViolations(
  content: string,
  codeMask: string,
  filePath: string,
): CheckViolation[] {
  const violations: CheckViolation[] = [];
  for (const match of codeMask.matchAll(/(?<![.\w$])jwt\s*\.\s*verify\b/g)) {
    if (match.index === undefined) continue;
    const afterCallee = match.index + match[0].length;
    const openingOffset = codeMask.slice(afterCallee).search(/\S/);
    const openingParenthesis = openingOffset === -1 ? -1 : afterCallee + openingOffset;
    if (openingParenthesis === -1 || codeMask[openingParenthesis] !== '(') continue;
    const closingParenthesis = closingFallbackCall(codeMask, openingParenthesis);
    if (
      closingParenthesis === -1 ||
      fallbackArgumentCount(content, codeMask, openingParenthesis, closingParenthesis) !== 2
    ) {
      continue;
    }
    violations.push(
      ...structuralViolation(
        'jwt-verify-no-algorithm',
        match.index,
        closingParenthesis + 1,
        content,
        filePath,
      ),
    );
  }
  return violations;
}

function structuralJwtFileViolations(
  content: string,
  codeMask: string,
  filePath: string,
): CheckViolation[] {
  const adapter = currentScope()?.languages.forFile(filePath);
  if (adapter?.id !== 'typescript') return fallbackJwtFileViolations(content, codeMask, filePath);
  const tree = getParseTree(adapter, filePath, content);
  if (!isOpaqueJwtNode(tree)) return fallbackJwtFileViolations(content, codeMask, filePath);

  const violations: CheckViolation[] = [];
  const visit = (node: OpaqueJwtNode): void => {
    const verifyCall = verifyCallFromNode(node, tree, content);
    const callSpan = verifyCall ? nodeSpan(verifyCall.call, tree) : null;
    if (
      verifyCall &&
      callSpan &&
      verifyCall.arguments.length === 2 &&
      isJwtReceiver(verifyCall, tree)
    ) {
      violations.push(
        ...structuralViolation(
          'jwt-verify-no-algorithm',
          callSpan.start,
          callSpan.end,
          content,
          filePath,
          tree,
        ),
      );
    }

    const options = verifyCall ? inlineOptionsObject(verifyCall.arguments[2], tree, content) : null;
    if (options && callSpan && !hasTopLevelIssuerOrAudience(options, tree, content)) {
      violations.push(
        ...structuralViolation(
          'missing-issuer-audience',
          callSpan.start,
          callSpan.end,
          content,
          filePath,
          tree,
        ),
      );
    }

    const algorithmArray = algorithmArrayFromNode(node, tree, content);
    const algorithmSpan = algorithmArray ? nodeSpan(algorithmArray.nameNode, tree) : null;
    const arraySpan = algorithmArray ? nodeSpan(algorithmArray.arrayNode, tree) : null;
    if (
      algorithmArray &&
      algorithmSpan &&
      arraySpan &&
      containsNoneLiteral(algorithmArray.arrayNode, tree, content)
    ) {
      violations.push(
        ...structuralViolation(
          'algorithm-none',
          algorithmSpan.start,
          arraySpan.end,
          content,
          filePath,
          tree,
        ),
      );
    }

    for (const child of node.getChildren?.(tree) ?? []) {
      if (isOpaqueJwtNode(child)) visit(child);
    }
  };
  visit(tree);
  for (const fallbackViolation of fallbackJwtFileViolations(content, codeMask, filePath)) {
    const duplicate = violations.some(
      (violation) =>
        violation.line === fallbackViolation.line &&
        violation.column === fallbackViolation.column &&
        violation.message === fallbackViolation.message,
    );
    if (!duplicate) violations.push(fallbackViolation);
  }
  return violations;
}

function structuralWeakSecretViolations(
  content: string,
  filePath: string,
  literals: readonly StaticStringLiteral[],
): CheckViolation[] {
  return literals.flatMap((literal) => {
    if (
      (literal.role !== 'assignment' &&
        literal.role !== 'initializer' &&
        literal.role !== 'object-property') ||
      !/^(?:jwtsecret|jwt_secret|jwt-secret|secret)$/i.test(literal.propertyName ?? '') ||
      literal.value.length > 20
    ) {
      return [];
    }
    const lineStart = content.lastIndexOf('\n', literal.start - 1) + 1;
    return [
      {
        line: content.slice(0, literal.start).split('\n').length,
        column: literal.start - lineStart,
        message: 'JWT secret appears weak (too short) - use a strong random secret',
        severity: 'warning' as const,
        suggestion:
          'Use a cryptographically strong random secret of at least 256 bits (32 bytes). Generate with: openssl rand -base64 32. Store in environment variable, not in code.',
        match: content.slice(literal.start, literal.end),
        filePath,
      },
    ];
  });
}

/**
 * Check if content contains JWT-related keywords.
 * Uses simple string matching to avoid regex issues.
 *
 * @param content - Content to check
 * @returns True if JWT keywords found
 */
function hasJwtKeywords(content: string): boolean {
  logger.debug({
    evt: 'fitness.checks.jwt_validation.has_jwt_keywords',
    msg: 'Checking if content contains JWT-related keywords',
  });
  const lowerContent = content.toLowerCase();
  return (
    lowerContent.includes('jwt') ||
    lowerContent.includes('jsonwebtoken') ||
    lowerContent.includes('jose')
  );
}

function jwtLineViolations(
  line: string,
  codeLine: string,
  lineNum: number,
  filePath: string,
  skipWeakSecretPattern: boolean,
): CheckViolation[] {
  if (line.trim().startsWith('//') || line.trim().startsWith('*')) return [];

  const violations: CheckViolation[] = [];
  for (const pattern of JWT_SECURITY_PATTERNS) {
    if (FILE_LEVEL_PATTERN_IDS.has(pattern.id)) continue;
    if (skipWeakSecretPattern && pattern.id === 'weak-jwt-secret') continue;
    if (!pattern.check) continue;
    for (const result of pattern.check(line, codeLine)) {
      if (!startsInCode(codeLine, result.matchIndex)) continue;
      violations.push({
        line: lineNum + 1,
        column: result.matchIndex,
        message: pattern.message,
        severity: pattern.severity,
        suggestion: pattern.suggestion,
        match: result.matchText,
        filePath,
      });
    }
  }
  return violations;
}

/**
 * Check: security/jwt-validation
 *
 * Validates JWT handling follows security best practices including
 * algorithm specification, proper verification, and strong secrets.
 */
export const jwtValidation = defineCheck({
  id: '2f5c06d9-4b94-4dbf-a071-5ae021819d61',
  slug: 'jwt-validation',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Validate JWT handling follows security best practices',
  longDescription: `**Purpose:** Validates that JWT handling code follows security best practices for token verification, algorithm selection, and secret strength.

**Detects:**
- \`jwt.verify(token, secret)\` with only 2 arguments (missing algorithms option) — enables algorithm substitution attacks
- \`jwt.decode\` used in auth context (decode does not verify signatures)
- Weak JWT secrets: short string literals (<=20 chars) assigned to jwt_secret/jwt-secret/secret variables
- Algorithm \`"none"\` in algorithms array — allows unsigned tokens
- \`.verify()\` calls with options object but missing issuer/audience validation

**Why it matters:** JWT misconfigurations are a top authentication bypass vector. Missing algorithm restriction, unverified tokens, and weak secrets can all lead to complete auth bypass.

**Scope:** General best practice. Analyzes each file individually. Only scans files containing jwt, jsonwebtoken, or jose references.`,
  tags: ['security', 'jwt', 'authentication'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    logger.debug({
      evt: 'fitness.checks.jwt_validation.analyze',
      msg: 'Analyzing file for JWT validation best practices',
    });
    // Skip files that don't deal with JWT
    if (!hasJwtKeywords(content)) {
      return [];
    }

    const lines = content.split('\n');
    const codeMask = createCodeMask(filePath, content);
    const codeLines = codeMask.split('\n');
    const staticLiterals = findStaticStringLiterals(filePath, content);
    const hasStructuralLiteralEvidence = staticLiterals.length > 0;
    const structuralViolations = hasStructuralLiteralEvidence
      ? structuralWeakSecretViolations(content, filePath, staticLiterals)
      : [];
    const lineViolations = lines.flatMap((line, lineNum) =>
      jwtLineViolations(
        line,
        codeLines[lineNum] ?? '',
        lineNum,
        filePath,
        hasStructuralLiteralEvidence,
      ),
    );
    return [
      ...structuralViolations,
      ...structuralJwtFileViolations(content, codeMask, filePath),
      ...lineViolations,
    ];
  },
});
