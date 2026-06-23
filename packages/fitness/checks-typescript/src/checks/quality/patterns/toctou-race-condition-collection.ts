/**
 * Local-collection and interface-field collection helpers for TOCTOU detection.
 */

import * as ts from 'typescript';

/** Function-like node types that can have TOCTOU patterns */
export type FunctionLikeNode =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression;

/** Check if node is a function-like node */
export function isFunctionLikeNode(node: ts.Node): node is FunctionLikeNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  );
}

const IN_MEMORY_COLLECTION_TYPE_NAMES = new Set([
  'Map',
  'WeakMap',
  'ReadonlyMap',
  'Set',
  'WeakSet',
  'ReadonlySet',
]);

function isInMemoryCollectionTypeNode(typeNode: ts.TypeNode | undefined): boolean {
  if (!typeNode) return false;
  if (ts.isTypeReferenceNode(typeNode)) {
    const name = typeNode.typeName;
    if (ts.isIdentifier(name)) {
      if (IN_MEMORY_COLLECTION_TYPE_NAMES.has(name.text)) return true;
      if (name.text.endsWith('Cache')) return true;
    }
  }
  return false;
}

function isInMemoryCollectionInitializer(init: ts.Expression | undefined): boolean {
  if (!init) return false;
  if (ts.isNewExpression(init) && ts.isIdentifier(init.expression)) {
    return IN_MEMORY_COLLECTION_TYPE_NAMES.has(init.expression.text);
  }
  return false;
}

/** Heuristic for in-process cache fields (`this.#cache`, `this.headerCache`, etc.). */
export function isInMemoryCacheReceiverText(text: string): boolean {
  const normalized = text.replace(/^[#_]/, '');
  if (normalized === 'cache') return true;
  if (normalized.endsWith('Cache')) return true;
  if (normalized.endsWith('.filteredContent')) return true;
  if (normalized.includes('parseCache')) return true;
  if (normalized === 'byId' || normalized === 'byName') return true;
  if (normalized.endsWith('.byId') || normalized.endsWith('.byName')) return true;
  if (normalized.endsWith('Handlers')) return true;
  return false;
}

/** Full dotted receiver chain for a property-access call target. */
export function getReceiverChainText(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(expr)) {
    const base = getReceiverChainText(expr.expression);
    if (base) return `${base}.${expr.name.text}`;
  }
  return null;
}

/** `const { byId } = this` aliases for class-owned Map/Set fields. */
export function collectThisCollectionFieldAliases(
  node: FunctionLikeNode,
  classCacheFields: ReadonlySet<string>,
): Set<string> {
  const aliases = new Set<string>();
  if (classCacheFields.size === 0) return aliases;

  const visit = (n: ts.Node): void => {
    if (n !== node && isFunctionLikeNode(n)) return;
    if (!ts.isVariableDeclaration(n) || !n.initializer) {
      ts.forEachChild(n, visit);
      return;
    }

    if (
      ts.isObjectBindingPattern(n.name) &&
      n.initializer.kind === ts.SyntaxKind.ThisKeyword
    ) {
      for (const element of n.name.elements) {
        if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
        const propName =
          element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text;
        if (classCacheFields.has(propName)) {
          aliases.add(element.name.text);
        }
      }
    }

    if (
      ts.isIdentifier(n.name) &&
      ts.isPropertyAccessExpression(n.initializer) &&
      n.initializer.expression.kind === ts.SyntaxKind.ThisKeyword &&
      classCacheFields.has(n.initializer.name.text)
    ) {
      aliases.add(n.name.text);
    }

    ts.forEachChild(n, visit);
  };

  if (node.body) visit(node.body);
  return aliases;
}

/** Map/Set names declared in enclosing functions (closure-visible locals). */
export function collectEnclosingLocalCollectionNames(node: FunctionLikeNode): Set<string> {
  const names = new Set<string>();
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (isFunctionLikeNode(current)) {
      for (const name of collectLocalCollectionNames(current)) {
        names.add(name);
      }
      const classFields = collectClassInMemoryFieldNames(current);
      for (const alias of collectThisCollectionFieldAliases(current, classFields)) {
        names.add(alias);
      }
    }
    current = current.parent;
  }

  return names;
}

/** Collect local Map/Set variable names within a function. */
export function collectLocalCollectionNames(node: FunctionLikeNode): Set<string> {
  const names = new Set<string>();

  for (const param of node.parameters) {
    if (ts.isIdentifier(param.name) && isInMemoryCollectionTypeNode(param.type)) {
      names.add(param.name.text);
    }
  }

  const visit = (n: ts.Node): void => {
    if (n !== node && isFunctionLikeNode(n)) return;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      (isInMemoryCollectionInitializer(n.initializer) || isInMemoryCollectionTypeNode(n.type))
    ) {
      names.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  if (node.body) visit(node.body);
  return names;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- AST walk over class members
export function collectClassInMemoryFieldNames(node: FunctionLikeNode): Set<string> {
  const names = new Set<string>();
  let cls: ts.Node | undefined = node.parent;
  while (cls && !ts.isClassDeclaration(cls) && !ts.isClassExpression(cls)) {
    cls = cls.parent;
  }
  if (!cls) return names;
  const classNode = cls;
  for (const member of classNode.members) {
    if (ts.isPropertyDeclaration(member)) {
      const memberName = member.name;
      let fieldName: string | undefined;
      if (ts.isIdentifier(memberName)) {
        fieldName = memberName.text;
      } else if (ts.isPrivateIdentifier(memberName)) {
        fieldName = memberName.text.replace(/^#/, '');
      }
      if (!fieldName) continue;
      if (
        isInMemoryCollectionInitializer(member.initializer) ||
        isInMemoryCollectionTypeNode(member.type)
      ) {
        names.add(fieldName);
      }
    }
  }
  return names;
}

/** Index file-local interface/type declarations to Map/Set field names. */
export function collectInterfaceCollectionFields(
  sourceFile: ts.SourceFile,
): Map<string, Set<string>> {
  const byType = new Map<string, Set<string>>();
  const fieldsFrom = (members: ts.NodeArray<ts.TypeElement>): Set<string> => {
    const fields = new Set<string>();
    for (const member of members) {
      if (
        ts.isPropertySignature(member) &&
        ts.isIdentifier(member.name) &&
        isInMemoryCollectionTypeNode(member.type)
      ) {
        fields.add(member.name.text);
      }
    }
    return fields;
  };
  for (const stmt of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(stmt)) {
      const fields = fieldsFrom(stmt.members);
      if (fields.size > 0) byType.set(stmt.name.text, fields);
    } else if (ts.isTypeAliasDeclaration(stmt) && ts.isTypeLiteralNode(stmt.type)) {
      const fields = fieldsFrom(stmt.type.members);
      if (fields.size > 0) byType.set(stmt.name.text, fields);
    }
  }
  return byType;
}

/** Collect `<receiver>.<field>` keys for state-bag Map/Set fields. */
export function collectLocalObjectCollectionFieldKeys(
  node: FunctionLikeNode,
  interfaceCollectionFields: ReadonlyMap<string, Set<string>>,
): Set<string> {
  const keys = new Set<string>();
  const addFor = (name: string, typeNode: ts.TypeNode | undefined): void => {
    if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return;
    if (!ts.isIdentifier(typeNode.typeName)) return;
    const fields = interfaceCollectionFields.get(typeNode.typeName.text);
    if (!fields) return;
    for (const field of fields) keys.add(`${name}.${field}`);
  };
  for (const param of node.parameters) {
    if (ts.isIdentifier(param.name)) addFor(param.name.text, param.type);
  }
  const visit = (n: ts.Node): void => {
    if (n !== node && isFunctionLikeNode(n)) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) addFor(n.name.text, n.type);
    ts.forEachChild(n, visit);
  };
  if (node.body) visit(node.body);
  return keys;
}
