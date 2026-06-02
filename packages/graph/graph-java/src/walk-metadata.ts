/**
 * @fileoverview Java-specific metadata extraction from tree-sitter nodes.
 *
 * Extracted from `walk.ts` to keep that module focused on the AST
 * traversal. Owns name / package / visibility / annotation / parameter
 * extraction — pure functions over tree-sitter nodes, no walker state.
 */

import type { JavaParsedFile } from './parse.js';
import type { FunctionOccurrence } from '@opensip-tools/graph';
import type Parser from 'tree-sitter';

export function packageQualifier(packageName: string, filePathProjectRel: string): string {
  if (packageName.length > 0) return packageName;
  // Fallback: derive a path-based qualifier (e.g. `src/main/java/Foo.java` →
  // `src.main.java.Foo`). Real Java files almost always have a `package`
  // declaration, so this is only hit for hand-written one-off files.
  return filePathProjectRel.replace(/\.java$/, '').replaceAll('/', '.');
}

export function extractPackageName(file: JavaParsedFile): string {
  for (const child of file.tree.rootNode.children) {
    if (child.type === 'package_declaration') {
      // package_declaration: `package` keyword + scoped/qualified identifier + `;`
      for (const c of child.namedChildren) {
        if (c.type === 'scoped_identifier' || c.type === 'identifier') return c.text;
      }
    }
  }
  return '';
}

/**
 * Find the `modifiers` named child of a method/constructor declaration.
 *
 * Note: tree-sitter-java exposes the modifier list as a named child of
 * type `modifiers`, NOT as a named field. `childForFieldName('modifiers')`
 * returns null — only iteration works.
 */
function findModifiersNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (const c of node.children) {
    if (c.type === 'modifiers') return c;
  }
  return null;
}

export function classifyVisibility(node: Parser.SyntaxNode): FunctionOccurrence['visibility'] {
  // Visibility keywords appear inside the `modifiers` node as anonymous
  // children with type === 'public' / 'protected' / 'private'.
  //   public / protected  → 'exported'
  //   private             → 'module-local' (file-local in Java terms)
  //   none                → 'module-local' (package-private)
  const modifiers = findModifiersNode(node);
  if (modifiers) {
    for (const c of modifiers.children) {
      if (c.type === 'public' || c.type === 'protected') return 'exported';
      if (c.type === 'private') return 'module-local';
    }
  }
  return 'module-local';
}

export function extractAnnotations(node: Parser.SyntaxNode): readonly string[] {
  const out: string[] = [];
  const modifiers = findModifiersNode(node);
  if (!modifiers) return out;
  for (const c of modifiers.children) {
    if (c.type === 'annotation' || c.type === 'marker_annotation') {
      out.push(c.text.trim());
    }
  }
  return out;
}

export function hasTestAnnotation(decorators: readonly string[]): boolean {
  for (const d of decorators) {
    // Matches `@Test`, `@org.junit.Test`, `@ParameterizedTest`, etc.
    if (/@(?:[\w.]*\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/.test(d)) {
      return true;
    }
  }
  return false;
}

export function extractParams(
  node: Parser.SyntaxNode,
): readonly { name: string; optional: boolean; rest: boolean }[] {
  const params = node.childForFieldName('parameters');
  if (!params) return [];
  const out: { name: string; optional: boolean; rest: boolean }[] = [];
  for (const child of params.namedChildren) {
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

export function extractLambdaParams(
  node: Parser.SyntaxNode,
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
    for (const c of params.namedChildren) {
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

function findIdentifierChild(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (const c of node.namedChildren) {
    if (c.type === 'identifier') return c;
  }
  /* v8 ignore next */
  return null;
}
