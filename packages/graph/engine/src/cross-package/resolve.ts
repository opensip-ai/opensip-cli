/**
 * Shared cross-package call resolver — the ONE resolution model both graph
 * engines link cross-package (workspace `@scope/pkg`) calls through.
 *
 * Background (ADR — exact↔sharded convergence). The graph tool builds the call
 * graph two ways:
 *   - SHARDED (default): per-package shards emit {@link CrossBoundaryCall}
 *     descriptors (import specifier + callee name) which the cross-shard linker
 *     resolves against the merged catalog's {@link ExportIndex}.
 *   - EXACT (`--exact`): one `ts.Program` over all source, resolved by the
 *     TypeScript type checker.
 *
 * The exact engine used to follow the type-checker alias straight into a
 * workspace package's BUILT `dist/*.d.ts` (Node16 resolves `@opensip-cli/*` to
 * the published declaration, not the source `.ts`). The `.d.ts` carries only a
 * bodiless signature, so hashing it never matched the SOURCE body the catalog
 * holds → the real cross-package edge was dropped (under-resolution); and the
 * downstream name-only catalog fallback then fabricated phantom edges by matching
 * a bare simple name with no import binding (over-resolution).
 *
 * This module factors the sharded linker's `(import specifier + callee name) →
 * unique exported SOURCE occurrence` resolution into one place BOTH engines call,
 * so the exact engine resolves cross-package calls the SAME way sharded does:
 * binding-required, decline-beats-guess. There is exactly one resolution model,
 * never two drifting copies.
 *
 * Engine-layer and language-agnostic: plain catalog + map/path math, no parser.
 */

import { resolveSpecifierToPackage } from './export-index.js';

import type { ExportIndex, PackageManifestIndex } from './export-index.js';
import type { FunctionOccurrence } from '../types.js';

/**
 * Choose the single exported occurrence an import specifier + callee name link
 * to, or `undefined` to DECLINE. Exactly one export → it. More than one (the
 * same simple name exported from multiple files in the package) → narrow to the
 * lone export whose project-relative file path matches the addressed subpath; if
 * that does not collapse the set to exactly one, DECLINE rather than guess. Zero
 * exports → decline (the name is not exported by this package — e.g. a re-export
 * chain the V1 linker does not follow).
 *
 * A missing edge is safe; a phantom cross-package edge fails the gate.
 */
export function linkExported(
  exported: readonly FunctionOccurrence[],
  subpath: string | undefined,
): FunctionOccurrence | undefined {
  if (exported.length === 1) return exported[0];
  if (exported.length === 0 || subpath === undefined) return undefined;
  // Subpath is `./rest` addressing a file within the imported package; keep only
  // exports whose file path matches that subpath stem (extension-insensitive).
  const stem = stripExt(subpath.replace(/^\.\//, ''));
  const narrowed = exported.filter((o) => {
    const fp = stripExt(o.filePath);
    return fp === stem || fp.endsWith(`/${stem}`) || fp.endsWith(`/${stem}/index`);
  });
  return narrowed.length === 1 ? narrowed[0] : undefined;
}

/** Inputs for {@link resolveCrossPackageCall}: the call's binding + the indexes. */
export interface CrossPackageCallInput {
  /** The RAW import specifier the callee name arrived through (`@scope/pkg[/sub]`). */
  readonly importSpecifier: string | undefined;
  /** The callee's simple name (`getSharedSourceFile`, `walkNodes`, …). */
  readonly calleeName: string;
  /** Per-package export symbol table built from the (merged / single) catalog. */
  readonly exportIndex: ExportIndex;
  /** Package `name` → manifest, turning a specifier into a package group. */
  readonly manifestIndex: PackageManifestIndex;
}

/**
 * Resolve a workspace (bare `@scope/pkg`) cross-package call to the UNIQUE
 * exported SOURCE occurrence the TypeScript type checker would pick — or
 * `undefined` to decline. The single seam both the sharded linker and the exact
 * adapter use for `@scope/pkg` calls:
 *
 *   1. no specifier, or a relative (`./x`) specifier → not a bare workspace
 *      import; return `undefined` (the caller handles relative/local pinning);
 *   2. specifier resolves to no tracked workspace package (external npm, or an
 *      unmappable subpath) → `undefined`;
 *   3. otherwise look the callee name up in that package's export bucket and
 *      {@link linkExported} it to a unique occurrence (else decline).
 */
export function resolveCrossPackageCall(
  input: CrossPackageCallInput,
): FunctionOccurrence | undefined {
  const { importSpecifier, calleeName, exportIndex, manifestIndex } = input;
  if (importSpecifier === undefined || importSpecifier.length === 0) return undefined;
  if (importSpecifier.startsWith('.')) return undefined; // relative — not this seam's job
  const resolved = resolveSpecifierToPackage(importSpecifier, manifestIndex);
  if (resolved === undefined) return undefined;
  const exported = exportIndex.get(resolved.packageGroup)?.get(calleeName) ?? [];
  return linkExported(exported, resolved.subpath);
}

function stripExt(p: string): string {
  return p.replace(/\.[A-Za-z0-9]+$/, '');
}
