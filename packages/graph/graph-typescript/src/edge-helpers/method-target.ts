// @fitness-ignore-file batch-operation-limits -- iterates a bounded collection (one symbol's declarations for a single method-call resolution), mirroring the property-access resolver.
/**
 * Type-attested cross-package METHOD target resolution (ADR-0033 follow-up).
 *
 * For a method call `recv.m()` the boundary extractor needs the TYPE-resolved
 * target file (not a syntactic name) to emit a cross-package boundary call. This
 * mirrors the symbol resolution `resolvePropertyAccessCall` does, but returns the
 * `m` decl's SOURCE file (the package's `dist/*.d.ts` mapped to source) rather
 * than a catalog hash — so the cross-shard linker can pin it post-merge against
 * the merged catalog, identically in both engines.
 */

import { relative, sep } from 'node:path';

import ts from 'typescript';

import { unaliasSymbol } from './unalias-symbol.js';

/**
 * The project-relative SOURCE file a method call's callee resolves to, when that
 * callee's declaration is a workspace package's built `dist/*.d.ts` — `null`
 * otherwise. `null` when: not a property-access call; the checker has no symbol;
 * the decl is SOURCE (the in-shard/inline pass handles it) or a non-workspace
 * `.d.ts` (`node_modules`, `lib.dom`, a non-`dist` ambient). The dist→src mapping
 * follows the tsc `outDir:dist` / `rootDir:src` convention; a wrong mapping just
 * fails to match an occurrence at the linker and declines (never fabricates).
 */
export function methodTargetFile(
  node: ts.Node,
  checker: ts.TypeChecker,
  projectDirAbs: string,
): string | null {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  const symbol = checker.getSymbolAtLocation(node.expression);
  if (!symbol) return null;
  const real = unaliasSymbol(symbol, checker);
  for (const d of real.getDeclarations() ?? []) {
    const sf = d.getSourceFile();
    // A SOURCE decl means the method lives in a file the in-shard/inline pass can
    // hash directly — not a cross-package boundary. Stop (don't keep scanning
    // other decls): the first declaration is the canonical one.
    if (!sf.isDeclarationFile) return null;
    const rel = relative(projectDirAbs, sf.fileName).split(sep).join('/');
    if (rel.includes('/node_modules/') || !rel.endsWith('.d.ts') || !rel.includes('/dist/')) {
      return null;
    }
    return rel.replace('/dist/', '/src/').replace(/\.d\.ts$/, '.ts');
  }
  return null;
}
