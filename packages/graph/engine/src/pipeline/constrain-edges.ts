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
 * occurrence in a package the caller can reach — the caller's own package, or
 * one its module imports. Type-checker-backed edges (`static`,
 * `method-dispatch`, `jsx`, `constructor`) are left untouched, so legitimate
 * edges — including re-export indirection the import set wouldn't capture —
 * are never dropped.
 *
 * The caller's import set is derived from each module's `dependencies[]`
 * **specifiers** (not their resolved `to`, which is empty for workspace
 * imports — the TS resolver points them at built `dist/*.d.ts` outside the
 * catalog) mapped through `packageGroupMap`. With no package map (non-monorepo
 * repos) or in `fast` mode (no `dependencies[]`), the catalog is returned
 * unchanged.
 */

import { packageOf } from '../resolve-callee.js';

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
 * target was removed). No-op in `fast` mode or when `packageGroupMap` is empty.
 */
export function constrainCrossPackageEdges(
  catalog: Catalog,
  packageGroupMap: ReadonlyMap<string, string>,
): Catalog {
  if (catalog.resolutionMode === 'fast' || packageGroupMap.size === 0) return catalog;

  const { occurrencesByHash } = buildHashMaps(catalog);
  const importedPackagesByFile = buildImportedPackagesByFile(catalog, packageGroupMap);

  const functions: Record<string, FunctionOccurrence[]> = {};
  for (const [name, occs] of Object.entries(catalog.functions)) {
    functions[name] = occs.map((occ) =>
      constrainOccurrence(occ, occurrencesByHash, importedPackagesByFile),
    );
  }
  return { ...catalog, functions };
}

/**
 * filePath → set of package groups it imports, derived from each module-init's
 * `dependencies[]` specifiers (the reliable signal — see file header).
 */
function buildImportedPackagesByFile(
  catalog: Catalog,
  packageGroupMap: ReadonlyMap<string, string>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const occs of Object.values(catalog.functions)) {
    for (const occ of occs) {
      if (occ.kind !== 'module-init') continue;
      addImportedGroups(out, occ, packageGroupMap);
    }
  }
  return out;
}

function addImportedGroups(
  out: Map<string, Set<string>>,
  occ: FunctionOccurrence,
  packageGroupMap: ReadonlyMap<string, string>,
): void {
  let set: Set<string> | undefined;
  for (const dep of occ.dependencies ?? []) {
    const group = specifierGroup(dep.specifier, packageGroupMap);
    if (group === undefined) continue;
    set ??= getOrCreate(out, occ.filePath);
    set.add(group);
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

/** Map an import specifier to its workspace package group, or undefined. */
function specifierGroup(
  specifier: string,
  packageGroupMap: ReadonlyMap<string, string>,
): string | undefined {
  // Relative imports stay within the caller's own package group, which the
  // own-package allowance already covers — skip them here.
  if (specifier.startsWith('.')) return undefined;
  return packageGroupMap.get(packageNameOf(specifier));
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

function constrainOccurrence(
  occ: FunctionOccurrence,
  occurrencesByHash: ReadonlyMap<string, readonly FunctionOccurrence[]>,
  importedPackagesByFile: ReadonlyMap<string, ReadonlySet<string>>,
): FunctionOccurrence {
  if (occ.calls.length === 0) return occ;
  const callerPkg = packageOf(occ.filePath);
  const reachable = reachablePackages(occ, importedPackagesByFile);

  let changed = false;
  const calls = occ.calls.map((edge) => {
    const constrained = constrainEdge(edge, reachable, callerPkg, occurrencesByHash);
    if (constrained !== edge) changed = true;
    return constrained;
  });
  return changed ? { ...occ, calls } : occ;
}

/** The set of package groups a caller occurrence can reach (own ∪ imported). */
function reachablePackages(
  occ: FunctionOccurrence,
  importedPackagesByFile: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  const imported = importedPackagesByFile.get(occ.filePath) ?? EMPTY_SET;
  const reachable = new Set<string>(imported);
  reachable.add(packageOf(occ.filePath));
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
    const pkg = packageOf(c.filePath);
    if (!reachable.has(pkg)) return false;
    return !(c.inTestFile && pkg !== callerPkg);
  });
}
