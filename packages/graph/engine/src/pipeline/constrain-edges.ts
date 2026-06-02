/**
 * Cross-package edge constraint — post-resolution catalog pass.
 *
 * Mode-agnostic correction for the impossible coupling edges (`core→fitness`,
 * `fitness→cli`, …). Name-based resolution can link a call to a function in a
 * package the caller never imports: `resolveByCatalogFallback` matches a
 * globally-unique simple name across all packages, and cross-shard recovery
 * matches bare-specifier names. The type-checker, by contrast, only resolves
 * to symbols the caller can actually reach.
 *
 * This pass drops the false edges that the name-based resolvers invent:
 * for every **name-guessed** edge (`resolution` ∈ {unknown, dynamic-string,
 * syntactic}) it keeps only the targets whose body hash has at least one
 * occurrence that is a valid callee for this caller — in a package the caller
 * can reach (own ∪ imported) and not another package's test file (a
 * cross-package test file is never importable). Type-checker-backed edges
 * (`static`, `method-dispatch`, `jsx`, `constructor`) are left untouched, so
 * legitimate edges — including re-export indirection — are never dropped.
 *
 * Package identity comes from `occurrence.package` (the nearest-`package.json`
 * name stamped by `assignPackages`); the caller's import set is the set of
 * package names its module's `dependencies[]` specifiers refer to — which, for
 * a workspace import, IS the imported package's name, so no separate lookup is
 * needed. No-op in `fast` mode (no `dependencies[]`). Must run after
 * `assignPackages`.
 */

import { pkgOf } from '../resolve-callee.js';

import { buildHashMaps } from './indexes.js';

import type { CallEdge, Catalog, CallResolution, FunctionOccurrence } from '../types.js';

/**
 * Resolutions produced by name/heuristic matching rather than the type
 * checker. Only these are import-constrained — a type-checker-backed edge
 * already reflects a symbol the caller can reach.
 */
const NAME_GUESSED: ReadonlySet<CallResolution> = new Set<CallResolution>([
  'unknown',
  'dynamic-string',
  'syntactic',
]);

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/**
 * Drop name-guessed call-edge targets that point into a package the caller
 * cannot reach. Returns a new catalog (occurrences/edges rebuilt only where a
 * target was removed). No-op in `fast` mode.
 */
export function constrainCrossPackageEdges(catalog: Catalog): Catalog {
  if (catalog.resolutionMode === 'fast') return catalog;

  const { occurrencesByHash } = buildHashMaps(catalog);
  const importedByFile = buildImportedPackagesByFile(catalog);

  const functions: Record<string, FunctionOccurrence[]> = {};
  for (const [name, occs] of Object.entries(catalog.functions)) {
    functions[name] = occs.map((occ) => constrainOccurrence(occ, occurrencesByHash, importedByFile));
  }
  return { ...catalog, functions };
}

/**
 * filePath → set of package names it imports, from each module-init's
 * `dependencies[]` specifiers. A workspace import specifier IS the imported
 * package's name (`@scope/pkg`), so it compares directly to `occurrence.package`.
 */
function buildImportedPackagesByFile(catalog: Catalog): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const occs of Object.values(catalog.functions)) {
    for (const occ of occs) {
      if (occ.kind !== 'module-init') continue;
      addImportedNames(out, occ);
    }
  }
  return out;
}

function addImportedNames(out: Map<string, Set<string>>, occ: FunctionOccurrence): void {
  let set: Set<string> | undefined;
  for (const dep of occ.dependencies ?? []) {
    // Relative imports stay within the caller's own package (covered by the
    // own-package allowance) — only bare/scoped specifiers name another package.
    if (dep.specifier.startsWith('.')) continue;
    set ??= getOrCreate(out, occ.filePath);
    set.add(packageNameOf(dep.specifier));
  }
}

function getOrCreate(map: Map<string, Set<string>>, key: string): Set<string> {
  let set = map.get(key);
  if (!set) {
    set = new Set<string>();
    map.set(key, set);
  }
  return set;
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

function constrainOccurrence(
  occ: FunctionOccurrence,
  occurrencesByHash: ReadonlyMap<string, readonly FunctionOccurrence[]>,
  importedByFile: ReadonlyMap<string, ReadonlySet<string>>,
): FunctionOccurrence {
  if (occ.calls.length === 0) return occ;
  const callerPkg = pkgOf(occ);
  const reachable = reachablePackages(occ, callerPkg, importedByFile);

  let changed = false;
  const calls = occ.calls.map((edge) => {
    const constrained = constrainEdge(edge, reachable, callerPkg, occurrencesByHash);
    if (constrained !== edge) changed = true;
    return constrained;
  });
  return changed ? { ...occ, calls } : occ;
}

/** The set of packages a caller occurrence can reach (own ∪ imported). */
function reachablePackages(
  occ: FunctionOccurrence,
  callerPkg: string,
  importedByFile: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  const imported = importedByFile.get(occ.filePath) ?? EMPTY_SET;
  const reachable = new Set<string>(imported);
  reachable.add(callerPkg);
  return reachable;
}

function constrainEdge(
  edge: CallEdge,
  reachable: ReadonlySet<string>,
  callerPkg: string,
  occurrencesByHash: ReadonlyMap<string, readonly FunctionOccurrence[]>,
): CallEdge {
  if (!NAME_GUESSED.has(edge.resolution) || edge.to.length === 0) return edge;
  const kept = edge.to.filter((hash) =>
    targetIsReachable(hash, reachable, callerPkg, occurrencesByHash),
  );
  return kept.length === edge.to.length ? edge : { ...edge, to: kept };
}

/**
 * A target hash is reachable if some occurrence sharing it is a valid callee
 * for this caller: in a reachable package (own ∪ imported) and not another
 * package's **test file**. A cross-package test file is never importable, so a
 * name-guessed edge into one (a builtin `.map`/`.find` colliding with a
 * test-local arrow named `map`/`find`) is an artifact, not real coupling.
 */
function targetIsReachable(
  hash: string,
  reachable: ReadonlySet<string>,
  callerPkg: string,
  occurrencesByHash: ReadonlyMap<string, readonly FunctionOccurrence[]>,
): boolean {
  const candidates = occurrencesByHash.get(hash) ?? [];
  return candidates.some((c) => {
    const pkg = pkgOf(c);
    if (!reachable.has(pkg)) return false;
    return !(c.inTestFile && pkg !== callerPkg);
  });
}
