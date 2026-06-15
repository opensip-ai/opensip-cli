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

import { resolveCrossPackageCall } from '@opensip-cli/graph';

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
      // signature. First try the export index (binding-required — for imported
      // FUNCTIONS). If that declines (e.g. a METHOD call `recv.m()` carries no
      // import binding for `m`), fall back to mapping the checker-attested
      // `dist/*.d.ts` decl to its SOURCE file and pinning by (source file +
      // name). The checker already disambiguated WHICH declaration (this class's
      // method in this file), so the pin is type-anchored, not a name guess — and
      // catalog-SCOPE-independent, so the exact (whole-repo) and sharded (per-
      // shard) passes resolve it identically instead of one declining while the
      // other resolves by an unsound unique-name-in-shard catalog fallback.
      (resolveAcrossPackageBoundary(candidateNames, bindingNames, ctx) ??
      pinByDtsDeclSource(declSourceFile, candidateNames, ctx))
    : // In-project source: hash the body and match it in the catalog; if the
      // body-hash match misses (e.g. arrow-property methods whose cataloged
      // occurrence the hasher can't reproduce from this decl node), fall back to
      // a file+name pin — the SAME unique-or-decline semantics sharded's
      // pinBySpecifier uses, so the two engines converge (Phase 3, Option A).
      (findCatalogEntry(declNode, declSourceFile, ctx.catalog, candidateNames) ??
      pinByFileAndName(declSourceFile, candidateNames, ctx));
  // Per-site decl-file discriminator trace — no-op unless GRAPH_SITE_LOG is set
  // (debug-only; isolated in resolution-trace.ts so this resolver stays env-clean).
  traceResolveDecl({ ctx, candidateNames, bindingNames, declSourceFile, dts, out });
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
  return pinBySourceRel(relPath, candidateNames, ctx);
}

/**
 * The catalog occurrence in `relPath` (a project-relative SOURCE path) whose
 * simpleName matches one of `candidateNames`. UNIQUE match → its bodyHash; zero
 * or >1 DISTINCT → null (decline). The shared unique-or-decline core of the
 * file+name pins.
 */
function pinBySourceRel(
  relPath: string,
  candidateNames: readonly string[],
  ctx: ResolverContext,
): string | null {
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
 * `.d.ts`→source pin: map the checker-attested `dist/*.d.ts` declaration file to
 * its SOURCE counterpart (tsc `outDir:dist` / `rootDir:src` convention) and pin
 * by (source file + name). Returns null when the path is not a `dist/*.d.ts`, or
 * when the mapped source has no unique matching occurrence (decline). Guarded by
 * the catalog match: a wrong mapping simply finds nothing and declines, so the
 * heuristic never fabricates an edge.
 *
 * RESTRICTED TO INTRA-PACKAGE targets (owner's package === target's package). A
 * method call whose receiver type flows through the OWNER package's OWN published
 * `.d.ts` (e.g. `scope.graph?.rules.getAll()` where `scope`'s type references the
 * graph package) resolves to a SOURCE occurrence in the same package — which is
 * in-shard for the sharded engine too, so BOTH engines resolve it identically. A
 * CROSS-package method target lives in another SHARD, which the sharded in-shard
 * pass cannot reach (method calls carry no import binding, so they don't ride the
 * cross-shard boundary linker); resolving those in exact alone would diverge.
 * Cross-package method resolution is the separate, larger completeness item
 * (guarded by the resolution-completeness floor), deliberately left declined in
 * BOTH engines here.
 */
function pinByDtsDeclSource(
  declSourceFile: ts.SourceFile,
  candidateNames: readonly string[],
  ctx: ResolverContext,
): string | null {
  const rel = relative(ctx.projectDirAbs, declSourceFile.fileName).split(sep).join('/');
  if (!rel.endsWith('.d.ts') || !rel.includes('/dist/')) return null;
  const srcRel = rel.replace('/dist/', '/src/').replace(/\.d\.ts$/, '.ts');
  const ownerRel = relative(ctx.projectDirAbs, ctx.sourceFile.fileName).split(sep).join('/');
  if (packageOf(srcRel) !== packageOf(ownerRel)) return null; // cross-package → decline (symmetry)
  return pinBySourceRel(srcRel, candidateNames, ctx);
}

/** The package-root prefix of a project-relative source path — everything before
 *  `/src/` (e.g. `packages/graph/engine/src/rules/registry.ts` → `packages/graph/engine`).
 *  Used to gate the `.d.ts`→source pin to intra-package targets. */
function packageOf(rel: string): string {
  const i = rel.indexOf('/src/');
  return i === -1 ? rel : rel.slice(0, i);
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
