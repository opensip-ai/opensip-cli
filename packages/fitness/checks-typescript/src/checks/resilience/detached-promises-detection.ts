/**
 * AST detection helpers for the detached-promises check.
 */

import { type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile, isInAsyncContext } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

import {
  buildEffectiveSyncSets,
  FILE_SKIP_PATTERNS,
  FIRE_AND_FORGET_PATTERNS,
  KNOWN_SYNC_RECEIVER_PATTERNS,
  KNOWN_SYNC_SUFFIXES,
  type EffectiveSyncSets,
} from './detached-promises-sync-constants.js';

/**
 * Check if a method call expression is to a known synchronous receiver or method.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- multi-pattern dispatcher: distinguishes receivers, methods, and aliased members across N known sync APIs
function isKnownSyncMethodCall(
  expr: ts.PropertyAccessExpression,
  sets: EffectiveSyncSets,
): boolean {
  const methodName = expr.name.text;
  const receiverExpr = expr.expression;

  if (
    sets.syncFunctions.has(methodName) ||
    FIRE_AND_FORGET_PATTERNS.has(methodName) ||
    matchesSyncNamePattern(methodName, sets)
  ) {
    return true;
  }

  if (ts.isIdentifier(receiverExpr)) {
    const receiverName = receiverExpr.text;
    if (sets.syncReceivers.has(receiverName)) {
      return true;
    }
    if (receiverName === 'this') {
      return false;
    }
  }

  if (ts.isPropertyAccessExpression(receiverExpr)) {
    const nestedName = receiverExpr.name.text;
    if (sets.syncReceivers.has(nestedName)) {
      return true;
    }
    let cursor: ts.Node = receiverExpr.expression;

    while (cursor && ts.isPropertyAccessExpression(cursor)) {
      cursor = cursor.expression;
    }
    if (ts.isIdentifier(cursor) && sets.syncReceivers.has(cursor.text)) {
      return true;
    }
  }

  if (ts.isIdentifier(receiverExpr)) {
    const receiverName = receiverExpr.text.toLowerCase();
    if (KNOWN_SYNC_RECEIVER_PATTERNS.some((pattern) => receiverName.includes(pattern))) {
      return true;
    }
  }

  return false;
}

function matchesSyncNamePattern(name: string, sets: EffectiveSyncSets): boolean {
  if (sets.syncPrefixes.some((prefix) => name.startsWith(prefix))) return true;
  if (KNOWN_SYNC_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  return false;
}

function isKnownSyncCall(node: ts.CallExpression, sets: EffectiveSyncSets): boolean {
  const expr = node.expression;

  if (expr.kind === ts.SyntaxKind.SuperKeyword) {
    return true;
  }

  if (ts.isIdentifier(expr)) {
    const name = expr.text;
    if (
      sets.syncFunctions.has(name) ||
      FIRE_AND_FORGET_PATTERNS.has(name) ||
      matchesSyncNamePattern(name, sets)
    ) {
      return true;
    }
  }

  if (ts.isPropertyAccessExpression(expr)) {
    return isKnownSyncMethodCall(expr, sets);
  }

  return false;
}

function hasPromiseChainHandling(node: ts.ExpressionStatement): boolean {
  const expr = node.expression;
  if (!ts.isCallExpression(expr)) return false;

  if (ts.isPropertyAccessExpression(expr.expression)) {
    const methodName = expr.expression.name.text;
    if (methodName === 'then' || methodName === 'catch' || methodName === 'finally') {
      return true;
    }
  }

  return false;
}

function isFloatingExpression(node: ts.ExpressionStatement): boolean {
  const expr = node.expression;

  if (expr.kind === ts.SyntaxKind.VoidExpression) {
    return false;
  }

  if (!ts.isCallExpression(expr)) return false;
  if (containsAwaitedReceiver(expr)) return false;
  if (hasAwaitedArgument(expr)) return false;

  return true;
}

function hasAwaitedArgument(call: ts.CallExpression): boolean {
  for (const arg of call.arguments) {
    if (isAwaitedExpression(arg)) return true;
  }
  return false;
}

function isAwaitedExpression(node: ts.Expression): boolean {
  let current: ts.Expression = node;

  while (current) {
    if (ts.isAwaitExpression(current)) return true;
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    break;
  }
  return false;
}

function containsAwaitedReceiver(call: ts.CallExpression): boolean {
  let current: ts.Expression = call.expression;

  while (current) {
    if (ts.isParenthesizedExpression(current)) {
      const inner = current.expression;
      if (ts.isAwaitExpression(inner)) return true;
      current = inner;
      continue;
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isCallExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    break;
  }
  return false;
}

function isDefinedAsSyncInSameFile(expr: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(expr.expression)) return false;
  const propAccess = expr.expression;
  if (propAccess.expression.kind !== ts.SyntaxKind.ThisKeyword) return false;

  const methodName = propAccess.name.text;

  let current: ts.Node | undefined = expr.parent;

  while (current && !ts.isClassDeclaration(current) && !ts.isClassExpression(current)) {
    current = current.parent;
  }

  if (!current) return false;

  for (const member of current.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    if (!ts.isIdentifier(member.name)) continue;
    if (member.name.text !== methodName) continue;

    const isAsync = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    return !isAsync;
  }

  return false;
}

/** Analyze a file for detached promise issues. */
export function analyzeFileForDetachedPromises(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];

  if (FILE_SKIP_PATTERNS.some((pattern) => filePath.includes(pattern))) {
    return violations;
  }

  const sets = buildEffectiveSyncSets();

  try {
    // @lazy-ok -- 'await' appears in string literals, not actual await expression
    const sourceFile = getSharedSourceFile(filePath, content);
    if (!sourceFile) return [];

    const visit = (node: ts.Node): void => {
      ts.forEachChild(node, visit);

      if (!ts.isExpressionStatement(node)) return;
      if (node.expression.kind === ts.SyntaxKind.VoidExpression) return;
      if (hasPromiseChainHandling(node)) return;

      const expr = node.expression;
      if (!ts.isCallExpression(expr)) return;
      if (!isInAsyncContext(node)) return;
      if (isKnownSyncCall(expr, sets)) return;
      if (isDefinedAsSyncInSameFile(expr)) return;
      if (!isFloatingExpression(node)) return;

      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      const lineNum = line + 1;
      const matchText = node.getText(sourceFile);

      violations.push({
        line: lineNum,
        column: character + 1,
        message: 'Possible detached promise (missing await)',
        severity: 'warning',
        type: 'detached-promise',
        suggestion:
          'Add await to ensure the promise is handled, or use void with error handling if intentionally fire-and-forget',
        match: matchText,
        filePath,
      });
    };

    visit(sourceFile);
  } catch {
    // @swallow-ok Skip files that fail to parse
  }

  return violations;
}