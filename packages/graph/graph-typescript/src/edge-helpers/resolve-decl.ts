/**
 * resolveDeclToHash — map a type-checker-resolved declaration to the catalog
 * bodyHash of its SOURCE occurrence.
 *
 * The single seam every exact-engine resolver (direct-call, property-access,
 * jsx-element, new-expression, polymorphic) routes a resolved declaration
 * through. It unifies the two ways a declaration's source body is reached:
 *
 *   1. IN-PROJECT SOURCE — the declaration lives in a `.ts(x)` file the program
 *      compiled from source. Hash the declaration body and match it in the
 *      catalog (the original {@link findCatalogEntry} behavior).
 *
 *   2. WORKSPACE-PACKAGE BOUNDARY — Node16 resolves a `@scope/pkg` import to the
 *      package's BUILT `dist/*.d.ts`, so the type checker hands back a BODILESS
 *      declaration. Hashing it never matches the SOURCE body the catalog holds
 *      → the real cross-package edge was dropped. Instead, re-resolve through
 *      the SAME export-index model the sharded linker uses: (the call site's
 *      import specifier for this name) + (callee name) → the UNIQUE exported
 *      source occurrence. Binding-required, so a bare name with no import never
 *      resolves (no phantom). Decline-beats-guess on ambiguity.
 *
 * A declaration in a `.d.ts` that is NOT a workspace package the importer bound
 * to (e.g. a `@types/*` ambient global like Vitest's `describe`, or `lib.dom`)
 * resolves to nothing — exactly right: those are not project functions.
 */

import { relative, sep } from 'node:path';

import { resolveCrossPackageCall } from '@opensip-tools/graph';

import { findCatalogEntry } from './find-catalog-entry.js';
import { traceResolveDecl } from './resolution-trace.js';

import type { ResolverContext } from '../edge-resolvers/types.js';
import type ts from 'typescript';

/**
 * Resolve `declNode` (a function-shaped node returned by
 * `functionLikeFromDeclaration`) to a catalog bodyHash, or `null` to decline.
 *
 * `candidateNames` is the simple name(s) the call site addressed — the EXPORTED
 * callee name (e.g. `getSharedSourceFile`, `walkNodes`). Used both for the
 * in-project hash lookup and the cross-package export lookup.
 *
 * `bindingNames` is the local binding name(s) that were IMPORTED in the call
 * site's file (the namespace receiver for `ns.fn()`, or the callee name itself
 * for a direct `fn()` / `<Fn/>` / `new Fn()`). The cross-package path requires
 * one of these to carry a workspace import specifier — a binding-required check
 * that rules out phantom same-name matches. When `bindingNames` is omitted it
 * defaults to `candidateNames` (direct calls bind by the callee name).
 */
export function resolveDeclToHash(
  declNode: ts.Node,
  declSourceFile: ts.SourceFile,
  candidateNames: readonly string[],
  ctx: ResolverContext,
  bindingNames: readonly string[] = candidateNames,
): string | null {
  const dts = declSourceFile.isDeclarationFile;
  const out = dts
    ? // Boundary case: the alias led into a built `.d.ts`. Don't hash the bodiless
      // signature; re-resolve through the export index, binding-required.
      resolveAcrossPackageBoundary(candidateNames, bindingNames, ctx)
    : // In-project source: hash the body and match it in the catalog; if the
      // body-hash match misses (e.g. arrow-property methods whose cataloged
      // occurrence the hasher can't reproduce from this decl node), fall back to
      // a file+name pin — the SAME unique-or-decline semantics sharded's
      // pinBySpecifier uses, so the two engines converge (Phase 3, Option A).
      (findCatalogEntry(declNode, declSourceFile, ctx.catalog, candidateNames) ??
      pinByFileAndName(declSourceFile, candidateNames, ctx));
  // Per-site decl-file discriminator trace — no-op unless GRAPH_SITE_LOG is set
  // (debug-only; isolated in resolution-trace.ts so this resolver stays env-clean).
  traceResolveDecl(ctx, candidateNames, bindingNames, declSourceFile, dts, out);
  return out;
}

/**
 * File+name pin: the catalog occurrence in `declSourceFile` (the file the type
 * checker attested the declaration lives in) whose simpleName matches one of
 * `candidateNames`. UNIQUE match → its bodyHash; zero or >1 DISTINCT → null
 * (decline). The lenient match sharded's `pinBySpecifier` uses, applied to the
 * checker-attested file: it never guesses the file (only the matching step) and
 * declines on same-name ambiguity — decline-beats-guess, identical semantics to
 * the sharded engine.
 */
function pinByFileAndName(
  declSourceFile: ts.SourceFile,
  candidateNames: readonly string[],
  ctx: ResolverContext,
): string | null {
  const relPath = relative(ctx.projectDirAbs, declSourceFile.fileName).split(sep).join('/');
  let found: string | null = null;
  for (const name of candidateNames) {
    const occs = ctx.catalog.functions[name];
    if (!occs) continue;
    for (const o of occs) {
      if (o.filePath !== relPath) continue;
      if (found !== null && found !== o.bodyHash) return null; // >1 distinct → ambiguous → decline
      found = o.bodyHash;
    }
  }
  return found;
}

/**
 * Cross-package boundary resolution: find the workspace import specifier one of
 * `bindingNames` was bound to IN THE CALL SITE'S FILE, then link (specifier +
 * exported callee name) to the unique exported source occurrence via the shared
 * resolver. Returns the first combination that resolves, or `null` (decline).
 * An import binding is REQUIRED — a name with no import in this file is not a
 * cross-package call (this is what eliminates the name-collision phantoms).
 */
function resolveAcrossPackageBoundary(
  candidateNames: readonly string[],
  bindingNames: readonly string[],
  ctx: ResolverContext,
): string | null {
  for (const bindingName of bindingNames) {
    const importSpecifier = ctx.importSpecifiers.get(bindingName);
    if (importSpecifier === undefined) continue; // not imported here → no binding
    for (const calleeName of candidateNames) {
      const linked = resolveCrossPackageCall({
        importSpecifier,
        calleeName,
        exportIndex: ctx.crossPackage.exportIndex,
        manifestIndex: ctx.crossPackage.manifestIndex,
      });
      if (linked !== undefined) return linked.bodyHash;
    }
  }
  return null;
}
