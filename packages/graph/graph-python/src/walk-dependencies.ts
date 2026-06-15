/**
 * @fileoverview Python import-statement → dependency-site emission.
 *
 * Extracted from `walk.ts` so the main walker stays focused on
 * function-occurrence construction.
 *
 * Walk a Python file's top-level statements for `import_statement` and
 * `import_from_statement` nodes; emit one `DependencySiteRecord` per
 * imported module (not per imported name). The owner is the file's
 * synthesized module-init occurrence (every file has exactly one).
 *
 * Phase 4 of opensip's substrate consolidation (DEC-498). The emitted
 * `specifier` preserves the raw dotted module path as written, including
 * any leading dots for relative imports (`'.foo'`, `'..pkg.bar'`).
 *
 * Out of scope at v1:
 *   - Wildcard `from foo import *` is treated like any other from-import:
 *     one dep site on the source module (`foo`); the `*` semantics
 *     (re-exports) are not modelled.
 *   - `__all__` semantics, dynamic `__import__` / `importlib.import_module`,
 *     and conditional / nested imports inside function bodies (only
 *     top-level imports are emitted).
 */

import { childrenOf, namedChildrenOf } from '@opensip-cli/graph-adapter-common';

import type { PythonParsedFile } from './parse.js';
import type { DependencySiteRecord } from '@opensip-cli/graph';
import type { Node } from '@opensip-cli/tree-sitter';

export function collectDependencySites(
  file: PythonParsedFile,
  moduleInitHash: string,
  out: DependencySiteRecord[],
): void {
  for (const stmt of namedChildrenOf(file.tree.rootNode)) {
    if (stmt.type === 'import_statement') {
      collectFromImportStatement(stmt, file, moduleInitHash, out);
    } else if (stmt.type === 'import_from_statement') {
      collectFromImportFromStatement(stmt, file, moduleInitHash, out);
    }
  }
}

/**
 * `import foo`, `import foo.bar`, `import foo as f`, `import a, b.c, d`.
 * Each name child is either a `dotted_name` or an `aliased_import` whose
 * `name` field is a `dotted_name`. Emits one dep site per top-level
 * comma-separated target.
 */
function collectFromImportStatement(
  stmt: Node,
  file: PythonParsedFile,
  moduleInitHash: string,
  out: DependencySiteRecord[],
): void {
  for (const child of namedChildrenOf(stmt)) {
    const dotted = resolveImportedNameDotted(child);
    if (!dotted) continue;
    pushDependencySite(stmt, file, moduleInitHash, dotted.text, out);
  }
}

/**
 * `from foo import x`, `from foo.bar import a, b`, `from . import x`,
 * `from .pkg import y`, `from ..parent import z`.
 *
 * The module-name field encodes the source module:
 *   - `dotted_name`     → absolute import (`from foo.bar import …`)
 *   - `relative_import` → leading dot(s) + optional `dotted_name`
 *
 * For `from . import name`, the relative_import has only dots (no
 * trailing dotted_name); the specifier is the leading-dot string
 * (e.g. `'.'`) — the *imported names* are themselves modules to resolve.
 * To preserve the one-dep-site-per-imported-module rule for this shape,
 * we walk the `name` field too and emit one site per imported name,
 * each carrying the prefix-dots + name (e.g. `.sibling`).
 *
 * For all other relative shapes (`from .pkg import x`, `from ..pkg.sub
 * import y`), the relative_import already carries the module path; we
 * emit ONE dep site with the raw relative-import text as specifier.
 */
function collectFromImportFromStatement(
  stmt: Node,
  file: PythonParsedFile,
  moduleInitHash: string,
  out: DependencySiteRecord[],
): void {
  const moduleNameField = stmt.childForFieldName('module_name');
  if (!moduleNameField) return;

  if (moduleNameField.type === 'dotted_name') {
    pushDependencySite(stmt, file, moduleInitHash, moduleNameField.text, out);
    return;
  }

  if (moduleNameField.type === 'relative_import') {
    collectFromRelativeImport(stmt, moduleNameField, file, moduleInitHash, out);
  }
}

/**
 * Handle the `from <relative_import> import …` case. Splits into two
 * shapes:
 *   - relative_import carries an inner dotted_name (`from .pkg import x`)
 *     → ONE dep site with `prefix + inner` as specifier.
 *   - relative_import is dots-only (`from . import sibling, other`)
 *     → ONE dep site PER imported name, specifier `prefix + name`.
 */
function collectFromRelativeImport(
  stmt: Node,
  moduleNameField: Node,
  file: PythonParsedFile,
  moduleInitHash: string,
  out: DependencySiteRecord[],
): void {
  const prefix = relativeImportPrefix(moduleNameField);
  const innerDotted = relativeImportInnerDotted(moduleNameField);
  if (innerDotted !== null) {
    // `from .pkg import x` — one site, specifier = '.pkg'
    pushDependencySite(stmt, file, moduleInitHash, prefix + innerDotted, out);
    return;
  }
  // `from . import sibling, other` — one site PER imported name,
  // specifier = `.sibling`, `.other`.
  for (const named of namedChildrenOf(stmt)) {
    // web-tree-sitter returns fresh Node wrappers per access, so `named`
    // is never reference-identical to `moduleNameField`; skip the module
    // node by its stable byte span instead of `===`.
    if (named.startIndex === moduleNameField.startIndex) continue;
    const dotted = resolveImportedNameDotted(named);
    if (!dotted) continue;
    pushDependencySite(stmt, file, moduleInitHash, prefix + dotted.text, out);
  }
}

/**
 * Resolve an imported-name child to its `dotted_name` node, if any.
 * Accepts either a bare `dotted_name` or an `aliased_import` whose
 * `name` field is a `dotted_name`. Returns null for anything else
 * (e.g. punctuation, comments).
 */
function resolveImportedNameDotted(named: Node): Node | null {
  if (named.type === 'dotted_name') return named;
  if (named.type === 'aliased_import') {
    const nameField = named.childForFieldName('name');
    if (nameField?.type === 'dotted_name') return nameField;
  }
  return null;
}

function relativeImportPrefix(node: Node): string {
  // The `import_prefix` child carries the leading dots as raw text.
  for (const child of childrenOf(node)) {
    if (child.type === 'import_prefix') return child.text;
  }
  /* v8 ignore next */
  return '';
}

function relativeImportInnerDotted(node: Node): string | null {
  for (const child of namedChildrenOf(node)) {
    if (child.type === 'dotted_name') return child.text;
  }
  return null;
}

function pushDependencySite(
  stmt: Node,
  file: PythonParsedFile,
  ownerHash: string,
  specifier: string,
  out: DependencySiteRecord[],
): void {
  out.push({
    nodeRef: stmt,
    sourceFileRef: file,
    ownerHash,
    specifier,
    line: stmt.startPosition.row + 1,
    column: stmt.startPosition.column,
  });
}
