/**
 * @fileoverview Java-specific metadata extraction from tree-sitter nodes.
 *
 * Extracted from `walk.ts` to keep that module focused on the AST
 * traversal. Owns name / package / visibility / annotation / parameter
 * extraction — pure functions over tree-sitter nodes, no walker state.
 */

import {
  childrenOf,
  namedChildrenOf,
  skipBlockComment,
  skipToEndOfLine,
} from '@opensip-cli/graph-adapter-common';

import type { JavaParsedFile } from './parse.js';
import type { FunctionOccurrence } from '@opensip-cli/graph';
import type { Node } from '@opensip-cli/tree-sitter';

export function packageQualifier(packageName: string, filePathProjectRel: string): string {
  if (packageName.length > 0) return packageName;
  // Fallback: derive a path-based qualifier (e.g. `src/main/java/Foo.java` →
  // `src.main.java.Foo`). Real Java files almost always have a `package`
  // declaration, so this is only hit for hand-written one-off files.
  return filePathProjectRel.replace(/\.java$/, '').replaceAll('/', '.');
}

export function extractPackageName(file: JavaParsedFile): string {
  for (const child of childrenOf(file.tree.rootNode)) {
    if (child.type === 'package_declaration') {
      // package_declaration: `package` keyword + scoped/qualified identifier + `;`
      for (const c of namedChildrenOf(child)) {
        const name = decodeQualifiedIdentifier(c);
        if (name !== null) return name;
      }
    }
  }
  return '';
}

/**
 * Decode an identifier / scoped_identifier from its named fields instead
 * of using `node.text`. Java permits comments between qualified-name tokens,
 * and those comments are part of a scoped node's source span.
 */
export function decodeQualifiedIdentifier(node: Node): string | null {
  if (node.type === 'identifier') return node.text;
  if (node.type !== 'scoped_identifier') return null;
  const scope = node.childForFieldName('scope');
  const name = node.childForFieldName('name');
  if (!scope || !name) return null;
  const decodedScope = decodeQualifiedIdentifier(scope);
  return decodedScope === null ? null : `${decodedScope}.${name.text}`;
}

/**
 * Find the `modifiers` named child of a method/constructor declaration.
 *
 * Note: tree-sitter-java exposes the modifier list as a named child of
 * type `modifiers`, NOT as a named field. `childForFieldName('modifiers')`
 * returns null — only iteration works.
 */
function findModifiersNode(node: Node): Node | null {
  for (const c of childrenOf(node)) {
    if (c.type === 'modifiers') return c;
  }
  return null;
}

export function classifyVisibility(node: Node): FunctionOccurrence['visibility'] {
  // Visibility keywords appear inside the `modifiers` node as anonymous
  // children with type === 'public' / 'protected' / 'private'.
  //   public / protected  → 'exported'
  //   private             → 'module-local' (file-local in Java terms)
  //   none in an interface → 'exported' (implicitly public)
  //   none in a class      → 'module-local' (package-private)
  const modifiers = findModifiersNode(node);
  if (modifiers) {
    for (const c of childrenOf(modifiers)) {
      if (c.type === 'public' || c.type === 'protected') return 'exported';
      if (c.type === 'private') return 'module-local';
    }
  }
  if (isDeclaredInInterface(node)) return 'exported';
  return 'module-local';
}

function isDeclaredInInterface(node: Node): boolean {
  let parent = node.parent;
  while (parent) {
    if (parent.type === 'interface_declaration' || parent.type === 'annotation_type_declaration') {
      return true;
    }
    if (
      parent.type === 'class_declaration' ||
      parent.type === 'record_declaration' ||
      parent.type === 'enum_declaration'
    ) {
      return false;
    }
    parent = parent.parent;
  }
  return false;
}

export function extractAnnotations(node: Node): readonly string[] {
  const out: string[] = [];
  const modifiers = findModifiersNode(node);
  if (!modifiers) return out;
  for (const c of childrenOf(modifiers)) {
    if (c.type === 'annotation' || c.type === 'marker_annotation') {
      out.push(c.text.trim());
    }
  }
  return out;
}

export function hasTestAnnotation(decorators: readonly string[]): boolean {
  for (const d of decorators) {
    if (TEST_ANNOTATION_NAMES.has(annotationSimpleName(d))) return true;
  }
  return false;
}

const TEST_ANNOTATION_NAMES: ReadonlySet<string> = new Set([
  'Test',
  'ParameterizedTest',
  'RepeatedTest',
  'TestFactory',
  'TestTemplate',
]);

function annotationSimpleName(decorator: string): string {
  let qualifiedName = '';
  let i = decorator.startsWith('@') ? 1 : 0;
  while (i < decorator.length) {
    if (decorator[i] === '(') break;
    const next2 = decorator.slice(i, i + 2);
    if (next2 === '/*') {
      i = skipBlockComment(decorator, i + 2);
      continue;
    }
    if (next2 === '//') {
      i = skipToEndOfLine(decorator, i);
      continue;
    }
    const c = decorator[i] ?? '';
    if (c !== ' ' && c !== '\t' && c !== '\f' && c !== '\r' && c !== '\n') {
      qualifiedName += c;
    }
    i++;
  }
  const lastDot = qualifiedName.lastIndexOf('.');
  return qualifiedName.slice(lastDot + 1);
}

export function extractParams(
  node: Node,
): readonly { name: string; optional: boolean; rest: boolean }[] {
  const params =
    node.childForFieldName('parameters') ??
    (node.type === 'compact_constructor_declaration' ? findEnclosingRecordParameters(node) : null);
  if (!params) return [];
  const out: { name: string; optional: boolean; rest: boolean }[] = [];
  for (const child of namedChildrenOf(params)) {
    if (child.type === 'formal_parameter' || child.type === 'spread_parameter') {
      const nameNode = child.childForFieldName('name') ?? findIdentifierChild(child);
      if (!nameNode) continue;
      out.push({
        name: nameNode.text,
        optional: false,
        rest: child.type === 'spread_parameter',
      });
    }
  }
  return out;
}

function findEnclosingRecordParameters(node: Node): Node | null {
  let parent = node.parent;
  while (parent) {
    if (parent.type === 'record_declaration') {
      return parent.childForFieldName('parameters');
    }
    parent = parent.parent;
  }
  return null;
}

export function extractLambdaParams(
  node: Node,
): readonly { name: string; optional: boolean; rest: boolean }[] {
  // tree-sitter-java's lambda_expression `parameters` can be:
  //   - identifier               — `x -> x + 1`
  //   - formal_parameters        — `(int x) -> x + 1`
  //   - inferred_parameters      — `(x, y) -> x + y`
  const params = node.childForFieldName('parameters');
  if (!params) return [];
  if (params.type === 'identifier') {
    return [{ name: params.text, optional: false, rest: false }];
  }
  if (params.type === 'inferred_parameters') {
    const out: { name: string; optional: boolean; rest: boolean }[] = [];
    for (const c of namedChildrenOf(params)) {
      if (c.type === 'identifier') out.push({ name: c.text, optional: false, rest: false });
    }
    return out;
  }
  // formal_parameters falls through to the standard extractor.
  /* v8 ignore start */
  if (params.type === 'formal_parameters') return extractParams(node);
  return [];
  /* v8 ignore stop */
}

function findIdentifierChild(node: Node): Node | null {
  for (const c of namedChildrenOf(node)) {
    if (c.type === 'identifier') return c;
    // Varargs `String... xs` are `spread_parameter` → nested `variable_declarator`.
    if (c.type === 'variable_declarator') {
      const nested = findIdentifierChild(c);
      if (nested) return nested;
      const nameField = c.childForFieldName('name');
      if (nameField?.type === 'identifier') return nameField;
    }
  }
  /* v8 ignore next */
  return null;
}
