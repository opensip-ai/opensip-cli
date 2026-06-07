/**
 * Cross-shard merge & semantic boundary linking (plan #2, Phase 2).
 *
 * After the shard workers return per-shard fragments + cross-boundary
 * call descriptors, this module:
 *   1. merges the fragments into one unified catalog (union of occurrences,
 *      each keeping its already-resolved intra-shard edges);
 *   2. LINKS the boundary calls semantically against the export symbol table
 *      ({@link ExportIndex}) + package manifest index ({@link PackageManifestIndex})
 *      built from the merged catalog and the resolved shard set, then stitches
 *      the recovered edges onto their owner occurrences as
 *      `resolution: 'semantic'`, `crossShard: true`, `confidence: 'high'`.
 *
 * The linker emits a cross-package edge ONLY when the import specifier + callee
 * name resolve to a UNIQUE exported occurrence in the imported package — exactly
 * what the TypeScript type checker would conclude. On ANY ambiguity (a name with
 * multiple matching exports the subpath can't disambiguate, a name the package
 * does not export, a specifier pointing at an external npm package) it DECLINES
 * and emits an unresolved (`to: []`) edge. A missing edge is safe; a phantom
 * cross-package edge would fail the gate. This replaces the old name-only
 * syntactic fallback, which fabricated impossible coupling edges by matching a
 * globally-unique simple name into a package the caller never imported.
 *
 * Intra-shard edges retain their original (semantic, in exact mode) fidelity;
 * relative imports are still path-pinned (already exact for same-package
 * imports). Engine-layer and language-agnostic: it operates on plain catalog
 * data + the descriptors' callee names / import specifiers + each package's
 * `package.json` — no parser, no TypeScript assumptions.
 */

import { posix } from 'node:path';

import { computeFilesFingerprint } from '../../cache/invalidate.js';
import { appendEdge, createMutableStats, truncateForCallEdge } from '../../lang-adapter/edge-helpers.js';

import { buildExportIndex, resolveSpecifierToPackage } from './export-index.js';

import type { ExportIndex, PackageManifestIndex } from './export-index.js';
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
  manifestIndex: PackageManifestIndex,
): CrossShardOutput {
  const merged = mergeShardFragments(fragments.map((f) => f.fragment), allFiles);
  const boundaryCalls = fragments.flatMap((f) => f.boundaryCalls);
  return resolveCrossBoundaryCalls(merged, boundaryCalls, manifestIndex);
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
 * stitch the recovered edge onto its owner. A recovered edge is `'semantic'`,
 * `crossShard: true`, `confidence: 'high'` — the import specifier + callee name
 * linked to a UNIQUE target occurrence (relative imports pin by path; bare /
 * workspace imports pin by the imported package's export symbol table). On any
 * ambiguity the resolver DECLINES (`to: []`) — a missing edge is safe, a phantom
 * cross-package edge is not. Declined / external boundary calls stay unresolved
 * but are counted (attributable).
 */
export function resolveCrossBoundaryCalls(
  merged: Catalog,
  boundaryCalls: readonly CrossBoundaryCall[],
  manifestIndex: PackageManifestIndex,
): CrossShardOutput {
  const exportIndex = buildExportIndex(merged);
  const nameIndex = buildNameIndex(merged);
  const fileByHash = buildFileByHash(merged);
  const knownFiles = new Set<string>(Object.values(merged.functions).flat().map((o) => o.filePath));

  const edgesByOwner = new Map<string, CallEdge[]>();
  const stats = createMutableStats();

  for (const bc of boundaryCalls) {
    const edge = resolveOne(bc, { exportIndex, manifestIndex, nameIndex, fileByHash, knownFiles });
    stats.totalCallSites++;
    appendEdge(edgesByOwner, bc.ownerHash, edge);
    stats.apply(edge);
  }

  const functions = stitchCrossShardEdges(merged.functions, edgesByOwner);
  return { catalog: { ...merged, functions }, boundaryStats: stats };
}

/** Indexes the boundary resolver links each call against. */
interface ResolveContext {
  /** Per-package export symbol table (the bare/workspace-specifier linker). */
  readonly exportIndex: ExportIndex;
  /** Package `name` → manifest, turning a specifier into a package group. */
  readonly manifestIndex: PackageManifestIndex;
  /** name → all occurrences with that name (the relative-import pin candidates). */
  readonly nameIndex: ReadonlyMap<string, readonly FunctionOccurrence[]>;
  readonly fileByHash: ReadonlyMap<string, string>;
  readonly knownFiles: ReadonlySet<string>;
}

/**
 * Resolve one cross-boundary call to a recovered edge — semantically, by
 * linking the import specifier + callee name to a UNIQUE target occurrence, or
 * DECLINING (`to: []`) when the link is absent or ambiguous. Three branches:
 *
 *  (a) RELATIVE specifier (`./x`) → pin by path against the owner's directory
 *      (an intra-package import; already exact). Emit when ≥1 occurrence in the
 *      resolved file matches the callee name.
 *  (b) BARE / workspace specifier that resolves to a known workspace package P →
 *      look the callee name up in P's export bucket: exactly 1 export → emit;
 *      >1 → narrow by a single subpath-pinned file if possible, else decline;
 *      0 → decline (not exported / re-export chain we don't follow).
 *  (c) Specifier maps to no known workspace package (external npm) → unresolved.
 *
 * A recovered edge is `'semantic'`, `crossShard: true`, `confidence: 'high'`.
 */
function resolveOne(bc: CrossBoundaryCall, ctx: ResolveContext): CallEdge {
  const base = {
    line: bc.line,
    column: bc.column,
    resolution: 'semantic' as const,
    text: truncateForCallEdge(bc.text),
    discarded: bc.discarded ?? false,
    crossShard: true as const,
    confidence: 'high' as const,
  };
  const spec = bc.importSpecifier;

  // (a) Relative import → path-pin (intra-package, already exact).
  if (spec?.startsWith('.')) {
    const candidates = ctx.nameIndex.get(bc.calleeName) ?? [];
    const pinned = pinBySpecifier(bc, candidates, ctx.fileByHash, ctx.knownFiles);
    return pinned.length > 0
      ? { ...base, to: pinned.map((o) => o.bodyHash) }
      : { ...base, to: [] };
  }

  // (b)/(c) Bare or workspace specifier → resolve to a package and link by export.
  if (spec === undefined || spec.length === 0) return { ...base, to: [] };
  const resolved = resolveSpecifierToPackage(spec, ctx.manifestIndex);
  if (resolved === undefined) {
    // No known workspace package (external npm, or unmappable subpath) — decline.
    return { ...base, to: [] };
  }
  const exported = ctx.exportIndex.get(resolved.packageGroup)?.get(bc.calleeName) ?? [];
  const linked = linkExported(exported, resolved.subpath);
  return linked === undefined ? { ...base, to: [] } : { ...base, to: [linked.bodyHash] };
}

/**
 * Choose the single exported occurrence the specifier + name link to, or
 * `undefined` to decline. Exactly one export → it. More than one (same simple
 * name exported from multiple files in the package) → narrow to the lone export
 * whose project-relative file path ends with the addressed subpath; if that
 * does not collapse the set to exactly one, DECLINE rather than guess. Zero
 * exports → decline (name not exported by this package — e.g. a re-export chain
 * the V1 linker does not follow).
 */
function linkExported(
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
   *  expected difference: edges only the semantic boundary linker recovers). */
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
