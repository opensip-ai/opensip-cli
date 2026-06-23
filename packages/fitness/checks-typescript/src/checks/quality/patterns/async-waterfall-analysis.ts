// @fitness-ignore-file null-safety -- null checks are intentional guards
import { getSharedSourceFile, isAsync } from '@opensip-cli/lang-typescript';
import type { CheckViolation } from '@opensip-cli/fitness';
import * as ts from 'typescript';

import { getBranchKey } from './async-waterfall-branch-keys.js';

export const MAX_LINE_GAP = 1;

export interface AwaitInfo {
  line: number;
  column: number;
  assignedVariable: string | null;
  destructuredBindings: readonly string[];
  expressionText: string;
  isDynamicImport: boolean;
  branchKey: string | null;
  node: ts.AwaitExpression;
}

const SLEEP_DELAY_NAMES = new Set(['sleep', 'delay', 'wait', 'setTimeout', 'pause']);
const LOCK_ACQUIRE_NAMES = new Set(['acquire', 'lock', 'runExclusive', 'withLock']);

function isAsyncFunction(node: ts.Node): boolean {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  ) {
    return isAsync(node);
  }
  return false;
}

function extractDestructuredBindings(
  pattern: ts.BindingPattern,
  sourceFile: ts.SourceFile,
): string[] {
  const names: string[] = [];

  for (const element of pattern.elements) {
    if (ts.isBindingElement(element)) {
      if (ts.isIdentifier(element.name)) {
        names.push(element.name.getText(sourceFile));
      } else if (
        ts.isObjectBindingPattern(element.name) ||
        ts.isArrayBindingPattern(element.name)
      ) {
        names.push(...extractDestructuredBindings(element.name, sourceFile));
      }
    }
  }

  return names;
}

function getAssignedVariable(
  awaitNode: ts.AwaitExpression,
  sourceFile: ts.SourceFile,
): string | null {
  const parent = awaitNode.parent;

  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.getText(sourceFile);
  }

  if (
    ts.isVariableDeclaration(parent) &&
    (ts.isObjectBindingPattern(parent.name) || ts.isArrayBindingPattern(parent.name))
  ) {
    return parent.name.getText(sourceFile);
  }

  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left)
  ) {
    return parent.left.getText(sourceFile);
  }

  return null;
}

function getDestructuredBindings(
  awaitNode: ts.AwaitExpression,
  sourceFile: ts.SourceFile,
): readonly string[] {
  const parent = awaitNode.parent;
  if (
    ts.isVariableDeclaration(parent) &&
    (ts.isObjectBindingPattern(parent.name) || ts.isArrayBindingPattern(parent.name))
  ) {
    return extractDestructuredBindings(parent.name, sourceFile);
  }
  return [];
}

function isDynamicImportExpression(awaitNode: ts.AwaitExpression): boolean {
  const expr = awaitNode.expression;
  return ts.isCallExpression(expr) && expr.expression.kind === ts.SyntaxKind.ImportKeyword;
}

export function collectAwaitExpressions(node: ts.Node, sourceFile: ts.SourceFile): AwaitInfo[] {
  const awaitInfos: AwaitInfo[] = [];

  const visit = (n: ts.Node) => {
    if (n !== node && isAsyncFunction(n)) {
      return;
    }

    if (ts.isAwaitExpression(n)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(n.getStart());
      const assignedVariable = getAssignedVariable(n, sourceFile);
      const destructuredBindings = getDestructuredBindings(n, sourceFile);
      const isDynamicImport = isDynamicImportExpression(n);
      const branchKey = getBranchKey(n, sourceFile, node);

      awaitInfos.push({
        line: line + 1,
        column: character + 1,
        assignedVariable,
        destructuredBindings,
        expressionText: n.getText(sourceFile),
        isDynamicImport,
        branchKey,
        node: n,
      });
    }

    ts.forEachChild(n, visit);
  };

  ts.forEachChild(node, visit);
  return awaitInfos;
}

function isSleepOrDelay(expressionText: string): boolean {
  const afterAwait = expressionText.replace(/^await\s+/, '');
  const match = /(?:this\.)?(\w+)\s*\(/.exec(afterAwait);

  if (match?.[1] !== undefined) {
    return SLEEP_DELAY_NAMES.has(match[1]);
  }
  return false;
}

function isLockAcquire(expressionText: string): boolean {
  const afterAwait = expressionText.replace(/^await\s+/, '');
  const match = /(?:this\.)?(\w+)\s*\(/.exec(afterAwait);

  if (match?.[1] !== undefined) {
    return LOCK_ACQUIRE_NAMES.has(match[1]);
  }
  return false;
}

function nextUsesDestructuredBindings(current: AwaitInfo, next: AwaitInfo): boolean {
  if (current.destructuredBindings.length === 0) {
    return false;
  }
  return current.destructuredBindings.some((binding) => next.expressionText.includes(binding));
}

function isAwaitingFunctionCall(expressionText: string): boolean {
  const afterAwait = expressionText.replace(/^await\s+/, '');
  return /\([^)]*\)\s*$/.test(afterAwait);
}

function shouldSkipAwaitPair(current: AwaitInfo, next: AwaitInfo): boolean {
  if (next.line - current.line > MAX_LINE_GAP + 1) return true;

  if (
    current.branchKey !== null &&
    next.branchKey !== null &&
    // @fitness-ignore-next-line unsafe-secret-comparison -- Comparing AST branch identifiers, not cryptographic keys
    current.branchKey !== next.branchKey
  ) {
    return true;
  }

  if (isSleepOrDelay(current.expressionText) || isSleepOrDelay(next.expressionText)) return true;
  if (isLockAcquire(current.expressionText)) return true;

  if (current.assignedVariable !== null && next.expressionText.includes(current.assignedVariable)) {
    return true;
  }

  if (nextUsesDestructuredBindings(current, next)) return true;
  if (current.isDynamicImport) return true;

  if (
    !isAwaitingFunctionCall(current.expressionText) ||
    !isAwaitingFunctionCall(next.expressionText)
  ) {
    return true;
  }

  return false;
}

export function detectWaterfalls(awaitInfos: AwaitInfo[]): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const sorted = [...awaitInfos].sort((a, b) => a.line - b.line);

  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];

    if (current === undefined || next === undefined) continue;
    if (shouldSkipAwaitPair(current, next)) continue;

    violations.push({
      line: current.line,
      column: current.column,
      message: 'Sequential await statements may be parallelizable with Promise.all()',
      severity: 'warning',
      suggestion:
        'Consider using Promise.all() to parallelize independent async operations. ' +
        'Example: const [result1, result2] = await Promise.all([asyncOp1(), asyncOp2()]);',
      type: 'async-waterfall',
      match: `${current.expressionText} followed by ${next.expressionText}`,
    });

    i++;
  }

  return violations;
}

export function analyzeFile(absolutePath: string, content: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const sourceFile = getSharedSourceFile(absolutePath, content);
  if (!sourceFile) return [];

  const visit = (node: ts.Node) => {
    if (isAsyncFunction(node)) {
      const asyncNode = node as ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction;
      const awaitInfos = collectAwaitExpressions(asyncNode, sourceFile);
      const newViolations = detectWaterfalls(awaitInfos);
      violations.push(...newViolations);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}