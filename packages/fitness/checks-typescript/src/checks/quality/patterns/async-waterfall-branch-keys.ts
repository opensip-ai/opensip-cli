import * as ts from 'typescript';

export function getIfElseBranchKey(current: ts.Node, sourceFile: ts.SourceFile): string | null {
  const parentNode = current.parent;
  if (!ts.isIfStatement(parentNode)) return null;

  const ifLine = sourceFile.getLineAndCharacterOfPosition(parentNode.getStart()).line;
  if (current === parentNode.thenStatement) return `if@L${ifLine}`;
  if (current === parentNode.elseStatement) return `else@L${ifLine}`;
  return null;
}

export function getTernaryBranchKey(current: ts.Node, sourceFile: ts.SourceFile): string | null {
  const parentNode = current.parent;
  if (!ts.isConditionalExpression(parentNode)) return null;

  const condLine = sourceFile.getLineAndCharacterOfPosition(parentNode.getStart()).line;
  if (current === parentNode.whenTrue) return `ternary-true@L${condLine}`;
  if (current === parentNode.whenFalse) return `ternary-false@L${condLine}`;
  return null;
}

export function getSwitchBranchKey(current: ts.Node, sourceFile: ts.SourceFile): string | null {
  if (!ts.isCaseClause(current) && !ts.isDefaultClause(current)) return null;

  // @fitness-ignore-next-line null-safety -- CaseClause/DefaultClause parent is CaseBlock, grandparent is SwitchStatement per TS AST spec
  const switchStmt = current.parent.parent;
  if (!ts.isSwitchStatement(switchStmt)) return null;

  const switchLine = sourceFile.getLineAndCharacterOfPosition(switchStmt.getStart()).line;
  if (ts.isCaseClause(current)) {
    const caseText = current.expression.getText(sourceFile);
    return `case-${caseText}@L${switchLine}`;
  }
  return `default@L${switchLine}`;
}

export function getBranchKey(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  functionNode: ts.Node,
): string | null {
  let current: ts.Node = node;

  while (current !== functionNode) {
    const ifElseKey = getIfElseBranchKey(current, sourceFile);
    if (ifElseKey) return ifElseKey;

    const ternaryKey = getTernaryBranchKey(current, sourceFile);
    if (ternaryKey) return ternaryKey;

    const switchKey = getSwitchBranchKey(current, sourceFile);
    if (switchKey) return switchKey;

    current = current.parent;
  }

  return null;
}