/**
 * @fileoverview Java import-declaration → dependency-site emission.
 *
 * Extracted from `walk.ts` so the main walker stays focused on
 * function-occurrence construction.
 *
 * We detect `static` by scanning the anonymous (non-named) children for
 * a token whose type is `'static'`, and detect the wildcard by checking
 * for a named `asterisk` child. The dotted path is the single named
 * `scoped_identifier` (or bare `identifier` in the degenerate
 * `import Foo;` default-package case) child.
 *
 * Out of scope at v1:
 *   - `module-info.java` `requires` directives (Java 9+ Java Platform
 *     Module System) — declarative module deps live there, not here.
 *   - Implicit `java.lang.*` imports — every Java file imports these,
 *     but we don't synthesize edges for non-explicit imports.
 *   - Implicit same-package visibility — Java doesn't require imports
 *     for sibling types in the same package; we likewise don't
 *     synthesize them.
 */

import { namedChildrenOf } from '@opensip-tools/graph-adapter-common';

import type { JavaParsedFile } from './parse.js';
import type { DependencySiteRecord } from '@opensip-tools/graph';
import type { Node } from 'web-tree-sitter';

export function collectDependencySites(
  file: JavaParsedFile,
  moduleInitHash: string,
  out: DependencySiteRecord[],
): void {
  for (const stmt of namedChildrenOf(file.tree.rootNode)) {
    if (stmt.type !== 'import_declaration') continue;
    const specifier = decodeImportSpecifier(stmt);
    if (specifier === null) continue;
    out.push({
      nodeRef: stmt,
      sourceFileRef: file,
      ownerHash: moduleInitHash,
      specifier,
      line: stmt.startPosition.row + 1,
      column: stmt.startPosition.column,
    });
  }
}

function decodeImportSpecifier(decl: Node): string | null {
  // `static` is an anonymous keyword child; scan all children (named +
  // anonymous) for it.
  let isStatic = false;
  for (let i = 0; i < decl.childCount; i++) {
    const c = decl.child(i);
    if (c?.type === 'static') {
      isStatic = true;
      break;
    }
  }
  // Named children hold the path (scoped_identifier or identifier) and
  // the optional `asterisk` wildcard. Scan in order.
  let path: string | null = null;
  let wildcard = false;
  for (const c of namedChildrenOf(decl)) {
    if (c.type === 'scoped_identifier' || c.type === 'identifier') {
      path = c.text;
    } else if (c.type === 'asterisk') {
      wildcard = true;
    }
  }
  if (path === null) /* v8 ignore next */ return null;
  const tail = wildcard ? `${path}.*` : path;
  return isStatic ? `static ${tail}` : tail;
}
