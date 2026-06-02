/**
 * Wave-4 incremental algorithm helpers.
 *
 * Self-contained: the closure-expansion fixpoint, occurrence merging,
 * and edge stitching for the incremental rebuild path. All functions
 * here are called by `catalog-builder.ts`; nothing else in the
 * orchestrator subtree depends on them.
 */

import { join, relative, sep } from 'node:path';

import { logger } from '@opensip-tools/core';

import { ownerEdgeKey } from '../../owner-key.js';

import type {
  GraphLanguageAdapter,
  DiscoverOutput,
  ParsedProject,
  WalkOutput,
} from '../../lang-adapter/types.js';
import type {
  Catalog,
  CallEdge,
  FunctionOccurrence,
} from '../../types.js';

export interface ClosureInput {
  readonly adapter: GraphLanguageAdapter;
  readonly discovery: DiscoverOutput;
  readonly cachedCatalog: Catalog;
  readonly parsedProject: ParsedProject;
  readonly changedFilesAbs: readonly string[];
}

export interface ClosureOutput {
  readonly walked: WalkOutput;
  readonly closureRel: ReadonlySet<string>;
}

/**
 * Expand the re-walk closure to a fixpoint. Starts with the directly
 * changed files; on each iteration walks the closure, finds hashes
 * that vanished, scans cached edges for any that still point at
 * vanished hashes, and adds those callers to the closure. Stops when
 * no new dependents are discovered.
 *
 * @throws {Error} When the incremental walk produces no result for a
 *   non-empty closure (a logic invariant violation in the walker).
 */
export function expandClosureToFixpoint(input: ClosureInput): ClosureOutput {
  const { adapter, discovery, cachedCatalog, parsedProject, changedFilesAbs } = input;
  const closureRel = new Set(
    changedFilesAbs.map((p) => relative(discovery.projectDirAbs, p).split(sep).join('/')),
  );
  const closureAbs = new Set(changedFilesAbs);
  const cachedHashesByFile = groupCachedHashesByFile(cachedCatalog);

  let walked: WalkOutput | null = null;
  // Iterate to fixpoint. On a typical 1-file change, this loop runs
  // exactly once — a file's hashes generally don't reach into
  // unchanged callers' edges. Worst case is bounded by file count
  // (each iteration adds at least one file).
  for (;;) {
    walked = adapter.walkProject({
      project: parsedProject,
      files: discovery.files.filter((p) => closureAbs.has(p)),
      projectDirAbs: discovery.projectDirAbs,
    });
    const grew = expandClosureOnce(
      walked,
      cachedCatalog,
      closureRel,
      closureAbs,
      cachedHashesByFile,
      discovery.projectDirAbs,
    );
    if (!grew) break;
  }
  /* v8 ignore next 3 */
  if (!walked) {
    throw new Error('incremental walk produced no result; closure was empty');
  }
  return { walked, closureRel };
}

function expandClosureOnce(
  walked: WalkOutput,
  cachedCatalog: Catalog,
  closureRel: Set<string>,
  closureAbs: Set<string>,
  cachedHashesByFile: ReadonlyMap<string, ReadonlySet<string>>,
  projectDirAbs: string,
): boolean {
  const newHashes = collectHashesFromOccurrences(walked.occurrences);
  const staleHashes = collectStaleHashes(closureRel, cachedHashesByFile, newHashes);
  // @fitness-ignore-next-line silent-early-returns -- `expandClosureOnce` returns boolean as its documented "did the closure grow this iteration?" contract; `false` is the fixed-point signal driving the outer expansion loop, not a hidden failure.
  if (staleHashes.size === 0) return false;
  const newDependents = findEdgeDependents(cachedCatalog, staleHashes, closureRel);
  // @fitness-ignore-next-line silent-early-returns -- same boolean "did closure grow?" contract as above; no new dependents means "fixed point reached".
  if (newDependents.length === 0) return false;

  /* v8 ignore start */
  let grew = false;
  for (const dep of newDependents) {
    if (closureRel.has(dep)) continue;
    closureRel.add(dep);
    // Use path.join so the result uses platform-native separators —
    // string concat + replace would leave backslashes from projectDirAbs
    // intact on Windows and produce a mixed-separator path that never
    // matches discovery.files entries.
    closureAbs.add(join(projectDirAbs, dep));
    grew = true;
  }
  if (grew) {
    logger.info({
      evt: 'graph.cache.incremental.expand',
      module: 'graph:cache',
      addedDependents: newDependents.length,
      closureSize: closureRel.size,
    });
  }
  return grew;
  /* v8 ignore stop */
}

function collectHashesFromOccurrences(
  functions: Record<string, FunctionOccurrence[]>,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const occs of Object.values(functions)) {
    if (!occs) continue;
    for (const o of occs) out.add(o.bodyHash);
  }
  return out;
}

function collectStaleHashes(
  closureRel: ReadonlySet<string>,
  cachedHashesByFile: ReadonlyMap<string, ReadonlySet<string>>,
  newHashes: ReadonlySet<string>,
): ReadonlySet<string> {
  const stale = new Set<string>();
  for (const fileRel of closureRel) {
    const cachedHashes = cachedHashesByFile.get(fileRel);
    if (!cachedHashes) continue;
    for (const h of cachedHashes) {
      if (!newHashes.has(h)) stale.add(h);
    }
  }
  return stale;
}

function groupCachedHashesByFile(catalog: Catalog): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const occs of Object.values(catalog.functions)) {
    if (!occs) continue;
    for (const o of occs) {
      let set = out.get(o.filePath);
      if (!set) {
        set = new Set();
        out.set(o.filePath, set);
      }
      set.add(o.bodyHash);
    }
  }
  return out;
}

/**
 * Find unchanged files whose cached edges have any `to` containing
 * a hash from `staleHashes`. Used by the incremental closure
 * expansion: if file A's cached edges point at a hash that no longer
 * exists, A must be re-walked too.
 */
function findEdgeDependents(
  catalog: Catalog,
  staleHashes: ReadonlySet<string>,
  alreadyClosed: ReadonlySet<string>,
): readonly string[] {
  const dependents = new Set<string>();
  for (const occs of Object.values(catalog.functions)) {
    if (!occs) continue;
    for (const o of occs) {
      if (alreadyClosed.has(o.filePath)) continue;
      if (dependents.has(o.filePath)) continue;
      if (occHasEdgeIntoStale(o, staleHashes)) dependents.add(o.filePath);
    }
  }
  return [...dependents].sort();
}

function occHasEdgeIntoStale(
  occ: FunctionOccurrence,
  staleHashes: ReadonlySet<string>,
): boolean {
  for (const edge of occ.calls) {
    for (const target of edge.to) {
      if (staleHashes.has(target)) return true;
    }
  }
  return false;
}

/**
 * Merge occurrences: for files in `closureRel`, take the freshly-
 * walked entries; for everything else, take the cached entries.
 * Re-keys by simpleName so the catalog shape matches the full-rebuild
 * output.
 */
export function mergeOccurrences(
  cachedCatalog: Catalog,
  walkedFunctions: Record<string, FunctionOccurrence[]>,
  closureRel: ReadonlySet<string>,
): Record<string, readonly FunctionOccurrence[]> {
  const out: Record<string, FunctionOccurrence[]> = Object.create(null) as Record<
    string,
    FunctionOccurrence[]
  >;
  // Lift cached entries for files NOT in the closure.
  for (const [name, occs] of Object.entries(cachedCatalog.functions)) {
    if (!occs) continue;
    for (const o of occs) {
      if (closureRel.has(o.filePath)) continue;
      pushOccurrence(out, name, o);
    }
  }
  // Add freshly-walked entries for closure files.
  for (const [name, occs] of Object.entries(walkedFunctions)) {
    if (!occs) continue;
    for (const o of occs) pushOccurrence(out, name, o);
  }
  return out;
}

function pushOccurrence(
  out: Record<string, FunctionOccurrence[]>,
  name: string,
  occ: FunctionOccurrence,
): void {
  let arr = out[name];
  if (!arr) {
    arr = [];
    out[name] = arr;
  }
  arr.push(occ);
}

/**
 * Stitch resolved edges into closure files; restore cached edges for
 * unchanged files. The merged catalog already has cached occurrences
 * for unchanged files; we just preserve their `calls` array.
 */
export function mergeResolvedAndCachedEdges(
  merged: Catalog,
  cached: Catalog,
  edgesByOwner: ReadonlyMap<string, readonly CallEdge[]>,
  closureRel: ReadonlySet<string>,
): Record<string, readonly FunctionOccurrence[]> {
  // Build a quick index of cached occurrences by bodyHash so we can
  // look up the right cached calls without scanning the catalog
  // per-occurrence.
  const cachedByOwner = new Map<string, FunctionOccurrence>();
  for (const occs of Object.values(cached.functions)) {
    if (!occs) continue;
    for (const o of occs) cachedByOwner.set(ownerEdgeKey(o.bodyHash, o.filePath), o);
  }
  const out: Record<string, FunctionOccurrence[]> = Object.create(null) as Record<
    string,
    FunctionOccurrence[]
  >;
  for (const [name, occs] of Object.entries(merged.functions)) {
    if (!occs) continue;
    const arr: FunctionOccurrence[] = [];
    for (const o of occs) {
      const ownerKey = ownerEdgeKey(o.bodyHash, o.filePath);
      if (closureRel.has(o.filePath)) {
        // Closure files keep their freshly-resolved edges.
        arr.push({ ...o, calls: edgesByOwner.get(ownerKey) ?? [] });
      } else {
        // Unchanged files: restore cached calls. The key matched
        // because we lifted the cached occurrence into the merged
        // catalog before resolver dispatch.
        const cachedOcc = cachedByOwner.get(ownerKey);
        arr.push({ ...o, calls: cachedOcc?.calls ?? [] });
      }
    }
    out[name] = arr;
  }
  return out;
}
