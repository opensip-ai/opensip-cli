import * as ts from 'typescript';

export const QUICK_FILTER_KEYWORDS = [
  '[]',
  'Array',
  'array',
  '.length',
  '.push',
  '.pop',
  '.map(',
  '.filter(',
];

const RELAXED_VALIDATION_PATHS = [
  /\/internal\//,
  /\/utils\//,
  /\/helpers\//,
  /\/cli\//,
  /\/scripts\//,
];

const COMPLEX_TYPE_PATTERNS = [
  'Record<',
  'Map<',
  '=> ',
  ': (',
  'Promise<',
  'Observable<',
];

export function isTopLevelArrayType(typeNode: ts.TypeNode): boolean {
  if (ts.isArrayTypeNode(typeNode)) {
    return true;
  }

  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName;
    if (ts.isIdentifier(typeName)) {
      const name = typeName.text;
      if (name === 'Array' || name === 'ReadonlyArray') {
        return true;
      }
    }
  }

  if (ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.length > 0 && typeNode.types.every((t) => isTopLevelArrayType(t));
  }

  if (ts.isParenthesizedTypeNode(typeNode)) {
    return isTopLevelArrayType(typeNode.type);
  }

  return false;
}

export function isRelaxedValidationPath(filePath: string): boolean {
  return RELAXED_VALIDATION_PATHS.some((pattern) => pattern.test(filePath));
}

export function isComplexNestedType(typeText: string): boolean {
  return COMPLEX_TYPE_PATTERNS.some((pattern) => typeText.includes(pattern));
}

export function isLengthAccess(node: ts.Node, paramName: string, sourceFile: ts.SourceFile): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false;
  const objName = node.expression.getText(sourceFile);
  const propName = node.name.getText(sourceFile);
  return objName === paramName && propName === 'length';
}

export function isArrayIsArrayCall(
  node: ts.Node,
  paramName: string,
  sourceFile: ts.SourceFile,
): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callText = node.expression.getText(sourceFile);
  if (callText !== 'Array.isArray') return false;
  const arg = node.arguments[0]?.getText(sourceFile);
  return arg === paramName;
}

export function isZodValidationCall(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  if (!ts.isCallExpression(node)) return false;
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const methodName = node.expression.name.getText(sourceFile);
  return methodName === 'parse' || methodName === 'safeParse';
}

export function isValidationFunctionCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  if (!ts.isIdentifier(node.expression)) return false;
  const funcName = node.expression.text.toLowerCase();
  return funcName.includes('validate') || funcName.includes('check');
}

export function isIterationOverParam(
  node: ts.Node,
  paramName: string,
  sourceFile: ts.SourceFile,
): boolean {
  if (ts.isForOfStatement(node)) {
    const iterableText = node.expression.getText(sourceFile);
    if (iterableText === paramName || iterableText.startsWith(`${paramName}.`)) {
      return true;
    }
  }

  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const objText = node.expression.expression.getText(sourceFile);
    const methodName = node.expression.name.getText(sourceFile);
    const iterationMethods = [
      'forEach',
      'map',
      'filter',
      'some',
      'every',
      'find',
      'findIndex',
      'findLast',
      'findLastIndex',
      'reduce',
      'reduceRight',
      'flatMap',
      'flat',
      'slice',
      'includes',
      'indexOf',
      'lastIndexOf',
      'join',
      'concat',
      'entries',
      'values',
      'keys',
      'at',
      'toSorted',
      'toReversed',
      'toSpliced',
      'with',
    ];
    if (objText === paramName && iterationMethods.includes(methodName)) {
      return true;
    }
  }

  return false;
}

export function isOutSinkUsage(node: ts.Node, paramName: string, sourceFile: ts.SourceFile): boolean {
  if (!ts.isCallExpression(node)) return false;
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const objText = node.expression.expression.getText(sourceFile);
  if (objText !== paramName) return false;
  const methodName = node.expression.name.getText(sourceFile);
  return methodName === 'push' || methodName === 'unshift' || methodName === 'splice';
}

export function isIndexedAccess(node: ts.Node, paramName: string, sourceFile: ts.SourceFile): boolean {
  if (!ts.isElementAccessExpression(node)) return false;
  return node.expression.getText(sourceFile) === paramName;
}

export function isSpreadOfParam(node: ts.Node, paramName: string, sourceFile: ts.SourceFile): boolean {
  if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) {
    return node.expression.getText(sourceFile) === paramName;
  }
  return false;
}

export function isForwardedToCall(
  node: ts.Node,
  paramName: string,
  _sourceFile: ts.SourceFile,
): boolean {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return false;
  const args = node.arguments;
  if (!args) return false;
  for (const arg of args) {
    if (ts.isIdentifier(arg) && arg.text === paramName) {
      return true;
    }
    if (ts.isAsExpression(arg) || ts.isSatisfiesExpression(arg)) {
      const inner = arg.expression;
      if (ts.isIdentifier(inner) && inner.text === paramName) {
        return true;
      }
    }
  }
  return false;
}

export function isShorthandPropertyReference(node: ts.Node, paramName: string): boolean {
  if (!ts.isShorthandPropertyAssignment(node)) return false;
  return node.name.text === paramName;
}

export function isOptionalHandling(
  node: ts.Node,
  paramName: string,
  sourceFile: ts.SourceFile,
): boolean {
  const nodeText = node.getText(sourceFile);
  if (nodeText.includes(`${paramName}?.`)) {
    return true;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    const leftText = node.left.getText(sourceFile);
    if (leftText === paramName) {
      return true;
    }
  }
  return false;
}