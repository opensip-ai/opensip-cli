/**
 * Cross-shard merge & boundary resolution (plan #2, Phase 2).
 *
 * After the shard workers return per-shard fragments + cross-boundary
 * call descriptors, this module:
 *   1. merges the fragments into one unified catalog (union of occurrences,
 *      each keeping its already-resolved intra-shard edges);
 *   2. resolves the boundary calls against that GLOBAL catalog + import
 *      graph — syntactically, since the ASTs are gone — and stitches the
 *      recovered edges onto their owner occurrences, labeled
 *      `resolution: 'syntactic'`, `crossShard: true`, capped confidence.
 *
 * This replaces the old fan-out behavior where cross-partition calls
 * "became unresolved." Intra-shard edges retain their original (semantic,
 * in exact mode) fidelity; only the genuinely cross-package edges are
 * approximate, and they are labeled as such.
 *
 * Engine-layer and language-agnostic: it operates on plain catalog data +
 * the descriptors' callee names / import specifiers. Specifier pinning is
 * generic path math (strip extension, resolve relative against the owner's
 * file) — no parser, no TypeScript assumptions.
 */

import { posix } from 'node:path';

import { computeFilesFingerprint } from '../../cache/invalidate.js';
import { appendEdge, createMutableStats, truncateForCallEdge } from '../../lang-adapter/edge-helpers.js';
import { packageOf } from '../../pipeline/resolve-callee.js';

import type { ShardBuildResult } from './shard-model.js';
import type {
  CallEdge,
  Catalog,
  CrossBoundaryCall,
  FunctionOccurrence,
  ResolutionStats,
} from '../../types.js';

/** Output of the cross-shard pass: the unified catalog + boundary-resolution stats. */
export interface CrossShardOutput {
  readonly catalog: Catalog;
  readonly boundaryStats: ResolutionStats;
}

/**
 * Merge per-shard fragments and recover cross-package edges. The single
 * Phase-2 entry the orchestrator calls.
 */
export function mergeAndResolveShards(
  fragments: readonly ShardBuildResult[],
  allFiles: readonly string[],
): CrossShardOutput {
  const merged = mergeShardFragments(fragments.map((f) => f.fragment), allFiles);
  const boundaryCalls = fragments.flatMap((f) => f.boundaryCalls);
  return resolveCrossBoundaryCalls(merged, boundaryCalls);
}

// ── Task 2.1: merge fragments ─────────────────────────────────────

/**
 * Union every fragment's `functions` map into one catalog. Each
 * occurrence keeps its already-resolved intra-shard `calls`. Shards are
 * disjoint by construction (distinct files), so occurrences don't
 * conflict; a defensive dedup by (bodyHash, filePath, line) drops any
 * accidental duplicate rather than double-counting.
 */
export function mergeShardFragments(
  fragments: readonly Catalog[],
  allFiles: readonly string[],
): Catalog {
  const functions: Record<string, FunctionOccurrence[]> = Object.create(null) as Record<
    string,
    FunctionOccurrence[]
  >;
  const seen = new Set<string>();
  for (const frag of fragments) addFragmentOccurrences(frag, functions, seen);

  const first = fragments[0];
  return {
    version: '3.0',
    tool: 'graph',
    language: first?.language ?? 'typescript',
    builtAt: new Date().toISOString(),
    // Build-level key derived from the per-shard keys so the merged
    // catalog invalidates when any shard's key changes.
    cacheKey: `sharded-${String(fragments.length)}-${hashKeys(fragments)}`,
    filesFingerprint: computeFilesFingerprint(allFiles),
    resolutionMode: first?.resolutionMode,
    functions,
  };
}

/** Append one fragment's occurrences into the merged map, deduping by
 *  (bodyHash, filePath, line). Extracted to keep mergeShardFragments flat. */
function addFragmentOccurrences(
  frag: Catalog,
  functions: Record<string, FunctionOccurrence[]>,
  seen: Set<string>,
): void {
  for (const [name, occs] of Object.entries(frag.functions)) {
    if (!occs) continue;
    for (const occ of occs) {
      const key = `${occ.bodyHash}|${occ.filePath}|${String(occ.line)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const bucket = functions[name];
      if (bucket) bucket.push(occ);
      else functions[name] = [occ];
    }
  }
}

function hashKeys(fragments: readonly Catalog[]): string {
  // Order-independent join of shard cacheKeys (shards may complete in any
  // order); kept short and deterministic.
  return [...fragments.map((f) => f.cacheKey)].sort().join('+').slice(0, 64);
}

// ── Task 2.2: resolve cross-boundary calls ────────────────────────

/**
 * Resolve each cross-boundary call against the merged global catalog and
 * stitch the recovered edge onto its owner. Edges are `'syntactic'`,
 * `crossShard: true`, with confidence capped at `'medium'` (when the
 * import specifier pinned the target file) or `'low'` (name-only).
 * Unresolvable boundary calls stay unresolved but are counted (attributable).
 */
export function resolveCrossBoundaryCalls(
  merged: Catalog,
  boundaryCalls: readonly CrossBoundaryCall[],
): CrossShardOutput {
  const nameIndex = buildNameIndex(merged);
  const fileByHash = buildFileByHash(merged);
  const knownFiles = new Set<string>(Object.values(merged.functions).flat().map((o) => o.filePath));
  const importedByFile = buildImportedPackagesByFile(merged, fileByHash);

  const edgesByOwner = new Map<string, CallEdge[]>();
  const stats = createMutableStats();

  for (const bc of boundaryCalls) {
    const edge = resolveOne(bc, nameIndex, fileByHash, knownFiles, importedByFile);
    stats.totalCallSites++;
    appendEdge(edgesByOwner, bc.ownerHash, edge);
    stats.apply(edge);
  }

  const functions = stitchCrossShardEdges(merged.functions, edgesByOwner);
  return { catalog: { ...merged, functions }, boundaryStats: stats };
}

function resolveOne(
  bc: CrossBoundaryCall,
  nameIndex: ReadonlyMap<string, readonly FunctionOccurrence[]>,
  fileByHash: ReadonlyMap<string, string>,
  knownFiles: ReadonlySet<string>,
  importedByFile: ReadonlyMap<string, ReadonlySet<string>>,
): CallEdge {
  const base = {
    line: bc.line,
    column: bc.column,
    resolution: 'syntactic' as const,
    text: truncateForCallEdge(bc.text),
    discarded: bc.discarded ?? false,
    crossShard: true as const,
  };
  const candidates = nameIndex.get(bc.calleeName) ?? [];
  if (candidates.length === 0) {
    // Genuinely external (e.g. an npm package) — unresolved, but counted.
    return { ...base, to: [], confidence: 'low' };
  }
  // Constrain to occurrences the caller can actually reach: its own package
  // or a package its module imports. This is what stops a globally-unique
  // name from resolving into a package the caller never imported (the source
  // of impossible coupling edges). Falls back to all candidates only when the
  // caller's file is unknown (cannot constrain).
  const reachable = reachableCandidates(bc, candidates, fileByHash, importedByFile);
  const pinned = pinBySpecifier(bc, reachable, fileByHash, knownFiles);
  if (pinned.length > 0) {
    return { ...base, to: pinned.map((o) => o.bodyHash), confidence: 'medium' };
  }
  const chosen = chooseReachable(bc, reachable, fileByHash);
  if (chosen) {
    return { ...base, to: [chosen.bodyHash], confidence: 'low' };
  }
  // No reachable target, or ambiguous after constraint — decline rather than
  // emit a wrong (cross-package) target.
  return { ...base, to: [], confidence: 'low' };
}

/** Candidates in the caller's own package or a package its module imports. */
function reachableCandidates(
  bc: CrossBoundaryCall,
  candidates: readonly FunctionOccurrence[],
  fileByHash: ReadonlyMap<string, string>,
  importedByFile: ReadonlyMap<string, ReadonlySet<string>>,
): readonly FunctionOccurrence[] {
  const ownerFile = fileByHash.get(bc.ownerHash);
  if (ownerFile === undefined) return candidates; // cannot constrain
  const callerPkg = packageOf(ownerFile);
  const imported = importedByFile.get(ownerFile) ?? EMPTY_PKG_SET;
  return candidates.filter((c) => {
    const p = packageOf(c.filePath);
    return p === callerPkg || imported.has(p);
  });
}

/** Pick a single reachable target: unique → it; else same-package unique → it; else decline. */
function chooseReachable(
  bc: CrossBoundaryCall,
  reachable: readonly FunctionOccurrence[],
  fileByHash: ReadonlyMap<string, string>,
): FunctionOccurrence | undefined {
  if (reachable.length === 0) return undefined;
  if (reachable.length === 1) return reachable[0];
  const ownerFile = fileByHash.get(bc.ownerHash);
  const callerPkg = ownerFile === undefined ? '<unknown>' : packageOf(ownerFile);
  const samePkg = reachable.filter((c) => packageOf(c.filePath) === callerPkg);
  return samePkg.length === 1 ? samePkg[0] : undefined;
}

const EMPTY_PKG_SET: ReadonlySet<string> = new Set<string>();

/** filePath → imported package groups, from module-init `dependencies[]`. */
function buildImportedPackagesByFile(
  merged: Catalog,
  fileByHash: ReadonlyMap<string, string>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const occs of Object.values(merged.functions)) {
    for (const occ of occs) {
      const pkgs = importedPackagesOf(occ, fileByHash);
      if (pkgs.size > 0) mergeSet(out, occ.filePath, pkgs);
    }
  }
  return out;
}

function mergeSet(map: Map<string, Set<string>>, key: string, values: ReadonlySet<string>): void {
  const existing = map.get(key);
  if (existing) {
    for (const v of values) existing.add(v);
    return;
  }
  map.set(key, new Set(values));
}

/** Package groups one module-init occurrence imports (via resolved dependencies[].to). */
function importedPackagesOf(
  occ: FunctionOccurrence,
  fileByHash: ReadonlyMap<string, string>,
): Set<string> {
  const set = new Set<string>();
  for (const dep of occ.dependencies ?? []) {
    for (const targetHash of dep.to) {
      const targetFile = fileByHash.get(targetHash);
      if (targetFile !== undefined) set.add(packageOf(targetFile));
    }
  }
  return set;
}

/**
 * Pin a boundary call to specific target occurrences via its import
 * specifier. Only RELATIVE specifiers are path-pinnable here (resolved
 * against the owner's file directory); bare/package specifiers fall
 * through to name-only resolution. Purely generic path math.
 */
function pinBySpecifier(
  bc: CrossBoundaryCall,
  candidates: readonly FunctionOccurrence[],
  fileByHash: ReadonlyMap<string, string>,
  knownFiles: ReadonlySet<string>,
): readonly FunctionOccurrence[] {
  const spec = bc.importSpecifier;
  if (!spec?.startsWith('.')) return [];
  const ownerFile = fileByHash.get(bc.ownerHash);
  if (ownerFile === undefined) return [];
  const resolved = posix.normalize(posix.join(posix.dirname(ownerFile), spec));
  const target = stripExt(resolved);
  // Accept either `<target>.<ext>` or `<target>/index.<ext>`.
  const matchesTarget = (filePath: string): boolean => {
    const fp = stripExt(filePath);
    return fp === target || fp === `${target}/index`;
  };
  // Only pin when the resolved target actually exists in the catalog.
  if (![...knownFiles].some(matchesTarget)) return [];
  return candidates.filter((c) => matchesTarget(c.filePath));
}

function stripExt(p: string): string {
  return p.replace(/\.[A-Za-z0-9]+$/, '');
}

// ── catalog helpers ───────────────────────────────────────────────

function buildNameIndex(catalog: Catalog): ReadonlyMap<string, readonly FunctionOccurrence[]> {
  const index = new Map<string, readonly FunctionOccurrence[]>();
  for (const [name, occs] of Object.entries(catalog.functions)) {
    if (occs && occs.length > 0) index.set(name, occs);
  }
  return index;
}

function buildFileByHash(catalog: Catalog): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const occs of Object.values(catalog.functions)) {
    if (!occs) continue;
    for (const o of occs) map.set(o.bodyHash, o.filePath);
  }
  return map;
}

/**
 * Stitch cross-shard edges onto each owner occurrence. A recovered edge
 * REPLACES the unresolved (`to: []`) intra-shard placeholder the local
 * resolver left at the same call site — otherwise the site would carry
 * two edges (one unresolved, one recovered) and double-count. Resolved
 * intra-shard edges are always kept.
 */
function stitchCrossShardEdges(
  functions: Readonly<Record<string, readonly FunctionOccurrence[]>>,
  edgesByOwner: ReadonlyMap<string, readonly CallEdge[]>,
): Record<string, readonly FunctionOccurrence[]> {
  const out: Record<string, readonly FunctionOccurrence[]> = Object.create(null) as Record<
    string,
    readonly FunctionOccurrence[]
  >;
  for (const [name, occs] of Object.entries(functions)) {
    if (!occs) continue;
    out[name] = occs.map((o) => {
      const extra = edgesByOwner.get(o.bodyHash);
      if (!extra || extra.length === 0) return o;
      const recoveredAt = new Set(extra.map((e) => `${String(e.line)}:${String(e.column)}`));
      // Drop the unresolved placeholder the local pass left at a recovered site.
      const kept = o.calls.filter(
        (e) => !(e.to.length === 0 && recoveredAt.has(`${String(e.line)}:${String(e.column)}`)),
      );
      return { ...o, calls: [...kept, ...extra] };
    });
  }
  return out;
}

// ── Task 2.3: correctness diff helper (test/validation) ───────────

export interface CatalogEdgeDiff {
  /** Intra-shard edges that differ between the two catalogs. MUST be empty
   *  for a correct sharded build vs whole-project build. */
  readonly intraMismatches: readonly string[];
  /** Cross-shard edges present in one catalog but not the other (the
   *  expected fidelity difference: recovered-but-syntactic). */
  readonly crossDifferences: readonly string[];
}

/**
 * Diff two catalogs by edge, partitioned into intra-shard mismatches
 * (expected empty) vs cross-shard differences (expected). An edge is keyed
 * by `ownerHash@line:col → sorted(to)`. Used by Phase 5 tests / Phase 6
 * validation to assert the sharded build matches the whole-project build
 * on intra-package edges.
 */
export function diffCatalogsByEdge(a: Catalog, b: Catalog): CatalogEdgeDiff {
  const ea = indexEdges(a);
  const eb = indexEdges(b);
  const intraMismatches: string[] = [];
  const crossDifferences: string[] = [];

  const keys = new Set<string>([...ea.keys(), ...eb.keys()]);
  for (const key of keys) {
    const x = ea.get(key);
    const y = eb.get(key);
    if (x?.to === y?.to) continue; // identical (or both absent) → no difference
    const isCross = (x?.crossShard ?? false) || (y?.crossShard ?? false);
    (isCross ? crossDifferences : intraMismatches).push(key);
  }
  return { intraMismatches, crossDifferences };
}

function indexEdges(catalog: Catalog): ReadonlyMap<string, { to: string; crossShard: boolean }> {
  const map = new Map<string, { to: string; crossShard: boolean }>();
  for (const occs of Object.values(catalog.functions)) {
    if (!occs) continue;
    for (const o of occs) {
      for (const e of o.calls) {
        const key = `${o.bodyHash}@${String(e.line)}:${String(e.column)}`;
        map.set(key, { to: [...e.to].sort().join(','), crossShard: e.crossShard ?? false });
      }
    }
  }
  return map;
}
