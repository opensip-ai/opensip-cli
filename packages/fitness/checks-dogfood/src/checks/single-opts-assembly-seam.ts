/**
 * @fileoverview CommandSpec options must flow through one opts assembly seam (ADR-0093).
 *
 * The CLI mounts tool commands through CommandSpec, and the suite orchestrator
 * re-dispatches the same specs. Both paths must use the extracted
 * `assembleOptsFromSpec` builder so defaults, repeatable-array defaults, parser
 * coercion, choices, and required validation cannot diverge. This check flags a
 * second hand-rolled `spec.options` → `opts` projection outside the sanctioned
 * shared builder and its Commander wiring sibling.
 */
// @fitness-ignore-file shipped-checks-must-be-generic -- ADR-0093 dogfood check: path-gated to opensip-cli command internals and intentionally enforces a monorepo-local host seam.
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

const ALLOWED_FILES: readonly string[] = [
  'packages/cli/src/commands/assemble-opts.ts',
  'packages/cli/src/commands/mount-command-spec-wiring.ts',
];

const GUARDED_PATHS: readonly string[] = ['packages/cli/src/commands/'];

const DEFAULT_PROPS = new Set(['default', 'arrayDefault', 'parse']);

function normalized(path: string): string {
  return path.replaceAll('\\', '/');
}

function isAllowedFile(path: string): boolean {
  return ALLOWED_FILES.some((allowed) => path.endsWith(allowed));
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function containsOptionsSource(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (
      (ts.isPropertyAccessExpression(child) && child.name.text === 'options') ||
      (ts.isElementAccessExpression(child) &&
        ts.isStringLiteral(child.argumentExpression) &&
        child.argumentExpression.text === 'options') ||
      (ts.isIdentifier(child) && child.text === 'options')
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function isOptionsIteration(node: ts.Node): boolean {
  if (ts.isForOfStatement(node)) {
    return containsOptionsSource(unwrapExpression(node.expression));
  }
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrapExpression(node.expression);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!['forEach', 'map', 'reduce'].includes(callee.name.text)) return false;
  return containsOptionsSource(unwrapExpression(callee.expression));
}

function containsDefaultOrParserUse(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(child) && DEFAULT_PROPS.has(child.name.text)) {
      found = true;
      return;
    }
    if (
      ts.isElementAccessExpression(child) &&
      ts.isStringLiteral(child.argumentExpression) &&
      DEFAULT_PROPS.has(child.argumentExpression.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function containsOptsWrite(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (
      ts.isVariableDeclaration(child) &&
      ts.isIdentifier(child.name) &&
      child.name.text === 'opts' &&
      child.initializer !== undefined
    ) {
      found = true;
      return;
    }
    if (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = unwrapExpression(child.left);
      if (ts.isElementAccessExpression(target) || ts.isPropertyAccessExpression(target)) {
        const base = unwrapExpression(target.expression);
        if (ts.isIdentifier(base) && base.text === 'opts') {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function functionName(node: ts.Node): string {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node)) &&
    node.name !== undefined
  ) {
    return node.name.getText();
  }
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return 'function';
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function functionBody(node: ts.Node): ts.ConciseBody | ts.Block | undefined {
  return (ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)) &&
    node.body !== undefined
    ? node.body
    : undefined;
}

/** Pure analysis over a parsed source file. Exported for unit tests. */
export function analyzeSingleOptsAssemblySeam(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const sourceFile = getSharedSourceFile(filePath, content);
  if (!sourceFile) return violations;

  const visit = (node: ts.Node): void => {
    const body = functionBody(node);
    if (body !== undefined) {
      let iteratesOptions = false;
      const findIteration = (child: ts.Node): void => {
        if (iteratesOptions) return;
        if (isOptionsIteration(child)) {
          iteratesOptions = true;
          return;
        }
        ts.forEachChild(child, findIteration);
      };
      findIteration(body);

      if (iteratesOptions && containsDefaultOrParserUse(body) && containsOptsWrite(body)) {
        violations.push({
          filePath,
          line: lineOf(sourceFile, node),
          message:
            `${functionName(node)} hand-rolls CommandSpec options into an opts object. ` +
            `ADR-0093 requires the CLI mount path and suite re-dispatch path to share the ` +
            `single assembleOptsFromSpec seam so defaults, array defaults, parser coercion, ` +
            `choices, and required validation cannot diverge.`,
          severity: 'error',
          suggestion:
            `Move this projection through packages/cli/src/commands/assemble-opts.ts ` +
            `(assembleOptsFromSpec). Commander construction belongs in ` +
            `mount-command-spec-wiring.ts; all runtime opts assembly should call the shared seam.`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export const singleOptsAssemblySeam = defineCheck({
  id: 'f9273b4d-355e-45c6-a24c-4be6f0f179b1',
  slug: 'single-opts-assembly-seam',
  contentFilter: 'raw',
  description:
    'CommandSpec option defaults/parsers must be assembled through the single shared assembleOptsFromSpec seam',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture'],
  fileTypes: ['ts', 'tsx'],
  analyze: (content: string, filePath: string) => {
    const path = normalized(filePath);
    if (isTestFile(path) || isAllowedFile(path)) return [];
    if (!GUARDED_PATHS.some((guarded) => path.includes(guarded))) return [];
    if (!content.includes('options') || !content.includes('opts')) return [];
    return analyzeSingleOptsAssemblySeam(content, path);
  },
});
