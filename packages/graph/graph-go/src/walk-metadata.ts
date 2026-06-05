// @fitness-ignore-file batch-operation-limits -- iterates the AST node arities of a single tree-sitter parse (bounded by source size); not a workspace-fanout loop.
/**
 * @fileoverview Go-specific metadata extraction from tree-sitter nodes.
 *
 * Extracted from `walk.ts` to keep that module focused on the AST
 * traversal. Owns the predicates / lookups that pull
 * package name, receiver type, parameter list, and visibility from
 * tree-sitter-go nodes — none of which depend on the walker's mutable
 * state, so they are safely free-standing helpers.
 */

import { childrenOf, namedChildrenOf } from '@opensip-tools/graph-adapter-common';

import type { GoParsedFile } from './parse.js';
import type { FunctionOccurrence } from '@opensip-tools/graph';
import type { Node } from '@opensip-tools/tree-sitter';

export function extractPackageName(file: GoParsedFile): string {
  for (const child of childrenOf(file.tree.rootNode)) {
    if (child.type === 'package_clause') {
      // package_clause: `package` keyword followed by identifier
      for (const c of childrenOf(child)) {
        if (c.type === 'package_identifier' || c.type === 'identifier') return c.text;
      }
    }
  }
  /* v8 ignore next */
  return 'main';
}

export function extractReceiverType(node: Node): string | null {
  // method_declaration has a `receiver` field of type parameter_list
  // containing one parameter_declaration. The declaration's `type`
  // is either pointer_type (e.g. `*Foo`) or type_identifier (`Foo`).
  const receiver = node.childForFieldName('receiver');
  if (!receiver) return null;
  for (const param of namedChildrenOf(receiver)) {
    if (param.type !== 'parameter_declaration') continue;
    const ty = param.childForFieldName('type') ?? param.namedChild(param.namedChildCount - 1);
    if (!ty) continue;
    return decodeReceiverTypeNode(ty);
  }
  /* v8 ignore next */
  return null;
}

function decodeReceiverTypeNode(node: Node): string | null {
  if (node.type === 'pointer_type') {
    // *Foo or *Foo[T] — descend through the pointer to the named type.
    const inner = node.namedChild(0);
    return inner ? decodeReceiverTypeNode(inner) : null;
  }
  if (node.type === 'type_identifier') return node.text;
  if (node.type === 'generic_type') {
    // Foo[T] — the trailing name is the type. tree-sitter-go usually
    // exposes the base via a named child.
    const inner = node.childForFieldName('type') ?? node.namedChild(0);
    return inner ? decodeReceiverTypeNode(inner) : null;
  }
  /* v8 ignore next */
  return node.text;
}

export function classifyVisibility(name: string): FunctionOccurrence['visibility'] {
  // Go visibility is determined by the first character's case. The
  // primary check is "is the first character an uppercase ASCII letter".
  // Unicode-case rules also count per the Go spec, but ASCII covers the
  // overwhelming majority of real-world Go.
  const first = name.charAt(0);
  if (first >= 'A' && first <= 'Z') return 'exported';
  return 'module-local';
}

export function extractParams(
  node: Node,
): readonly { name: string; optional: boolean; rest: boolean }[] {
  const params = node.childForFieldName('parameters');
  if (!params) return [];
  return collectParamEntries(params);
}

// Closures share the same parameters field shape as function_declaration.
export const extractClosureParams = extractParams;

function collectParamEntries(
  params: Node,
): readonly { name: string; optional: boolean; rest: boolean }[] {
  const out: { name: string; optional: boolean; rest: boolean }[] = [];
  for (const child of namedChildrenOf(params)) {
    if (child.type !== 'parameter_declaration' && child.type !== 'variadic_parameter_declaration') {
      continue;
    }
    const isRest = child.type === 'variadic_parameter_declaration';
    // A parameter_declaration may bind multiple names to one type:
    // `func f(a, b int)` produces a single declaration node with two
    // `name` children. Iterate the named identifiers.
    for (const inner of namedChildrenOf(child)) {
      if (inner.type === 'identifier') {
        out.push({ name: inner.text, optional: false, rest: isRest });
      }
    }
  }
  return out;
}
