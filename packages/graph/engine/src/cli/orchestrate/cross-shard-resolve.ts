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

import { stampEngineVersion } from '../../cache/engine-version.js';
import { computeFilesFingerprint } from '../../cache/invalidate.js';
import { buildExportIndex } from '../../cross-package/export-index.js';
import { resolveCrossPackageCall } from '../../cross-package/resolve.js';
import { appendEdge, createMutableStats, truncateForCallEdge } from '../../lang-adapter/edge-helpers.js';
import { computeSccs } from '../../pipeline/features.js';
import { buildIndexes } from '../../pipeline/indexes.js';


import type { ShardBuildResult } from './shard-model.js';
import type { ExportIndex, PackageManifestIndex } from '../../cross-package/export-index.js';
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
 * conflict; a defensive dedup by occurrence IDENTITY — (bodyHash,
 * filePath, line, column) — drops any accidental duplicate rather than
 * double-counting.
 *
 * The dedup key MUST include `column`: two distinct callables can share a
 * `(bodyHash, filePath, line)` triple when they sit on the SAME source line
 * with BYTE-IDENTICAL bodies — e.g. `a.some((p) => p.test(x)) || b.some((p) =>
 * p.test(x))` (two body-twin arrows on one line). `bodyHash` is a CONTENT hash,
 * so both twins hash equally; a column-less key collapsed them into one,
 * dropping the second occurrence the single-program engine keeps. Keying on the
 * full occurrence identity (filePath:line:column — the same tuple the SCC graph
 * uses as its node id) makes the merged function set byte-identical to exact
 * (Phase 3 closed the residual 2-occurrence delta this way).
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

  // Canonicalize: shards complete in nondeterministic order, so the merged
  // function-name keys, occurrence buckets, and each occurrence's `calls` are
  // all sorted by a stable key here. This makes the merged catalog a pure
  // function of the fragment SET — independent of shard completion order — so
  // cold, warm-all-cached, and warm-partial-rebuild produce a byte-identical
  // catalog (Phase 3).
  const canonicalFunctions = canonicalizeFunctions(functions);

  const first = fragments[0];
  return {
    version: '3.0',
    tool: 'graph',
    language: first?.language ?? 'typescript',
    // `builtAt` is the SOLE intentionally-nondeterministic catalog field — a
    // wall-clock stamp. It is excluded from structural determinism/equivalence
    // comparisons (Phase 0 determinism test, Phase 4 guardrail). Everything
    // else in this catalog is a pure function of the fragment set.
    builtAt: new Date().toISOString(),
    // Build-level key derived from the per-shard keys so the merged
    // catalog invalidates when any shard's key changes. Stamped with the
    // engine version + `mode=sharded` (same channel as the single-program
    // exact key) so the two engines — which share the single `graph_catalog`
    // row but build structurally incompatible catalogs — can never read each
    // other's row: a mode switch is a clean `cacheKey` mismatch (a rebuild),
    // never a silent cross-engine read of a clobbered row.
    cacheKey: stampEngineVersion(
      `sharded-${String(fragments.length)}-${hashKeys(fragments)}`,
      'sharded',
    ),
    filesFingerprint: computeFilesFingerprint(allFiles),
    resolutionMode: first?.resolutionMode,
    functions: canonicalFunctions,
  };
}

/**
 * Build a canonical copy of a merged function map: function-name keys inserted
 * in sorted order, each function's occurrence bucket sorted by a stable key
 * (`filePath`, then `line`, then `bodyHash`), and each occurrence's `calls`
 * sorted by `(line, column, sorted(to))`. The catalog shape is unchanged —
 * only the ordering becomes deterministic regardless of the order shards
 * completed in. (JSON serialization preserves insertion order, so sorting the
 * top-level keys is what makes the serialized catalog byte-identical.)
 */
function canonicalizeFunctions(
  functions: Record<string, FunctionOccurrence[]>,
): Record<string, FunctionOccurrence[]> {
  const out: Record<string, FunctionOccurrence[]> = Object.create(null) as Record<
    string,
    FunctionOccurrence[]
  >;
  for (const name of Object.keys(functions).sort()) {
    const occs = functions[name];
    if (!occs) continue;
    const sorted = [...occs].sort(compareOccurrences);
    out[name] = sorted.map((occ) => ({ ...occ, calls: sortCalls(occ.calls) }));
  }
  return out;
}

/** Stable occurrence order: filePath, then line, then bodyHash. */
function compareOccurrences(a: FunctionOccurrence, b: FunctionOccurrence): number {
  return (
    a.filePath.localeCompare(b.filePath) ||
    a.line - b.line ||
    a.bodyHash.localeCompare(b.bodyHash)
  );
}

/** Stable edge order within an occurrence: line, then column, then sorted(to). */
function sortCalls(calls: readonly CallEdge[]): CallEdge[] {
  return [...calls].sort(
    (a, b) =>
      a.line - b.line ||
      a.column - b.column ||
      [...a.to].sort().join(',').localeCompare([...b.to].sort().join(',')),
  );
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
      const key = `${occ.bodyHash}|${occ.filePath}|${String(occ.line)}|${String(occ.column)}`;
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

  // (b)/(c) Bare or workspace specifier → resolve to a package and link by export
  // through the SHARED cross-package resolver the exact adapter also uses.
  const linked = resolveCrossPackageCall({
    importSpecifier: spec,
    calleeName: bc.calleeName,
    exportIndex: ctx.exportIndex,
    manifestIndex: ctx.manifestIndex,
  });
  return linked === undefined ? { ...base, to: [] } : { ...base, to: [linked.bodyHash] };
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
      // Re-canonicalize the merged edge list — `extra` is in boundary-call
      // (flat-map) order, which depends on shard completion order; sorting here
      // keeps the stitched occurrence byte-identical across runs.
      return { ...o, calls: sortCalls([...kept, ...extra]) };
    });
  }
  return out;
}

// ── Task 2.3 / Phase 3: equivalence diff (test/validation) ────────

/**
 * The full sharded≡exact equivalence verdict — the Phase-4 gate's currency.
 * Five partitions, ALL of which MUST be empty for the sharded build to be
 * byte-equivalent to the single-program build:
 *
 *  - `functionsOnlyInA` / `functionsOnlyInB` — symmetric difference of the
 *    occurrence IDENTITY sets (the function set itself). A non-empty side means
 *    one engine discovered a function the other did not — a discovery/merge
 *    divergence, NOT an edge difference. (This is the partition that caught the
 *    two body-twin arrows the column-less merge dedup dropped; see
 *    `mergeShardFragments`.)
 *  - `intraMismatches` / `crossDifferences` — edges whose target set differs,
 *    partitioned by whether either side is a cross-shard (boundary-linked) edge
 *    (see {@link CatalogEdgeDiff}).
 *  - `sccDifferences` — strongly-connected components present in one catalog's
 *    occId-keyed SCC graph but not the other (by sorted-member signature). SCCs
 *    drive the `cycle` rule's findings, so an SCC divergence is a gate-visible
 *    divergence even when every individual edge matches (e.g. a dropped function
 *    that was a cycle member changes the component).
 *
 * `equivalence` ⇔ every partition empty.
 */
export interface CatalogEquivalence {
  readonly functionsOnlyInA: readonly string[];
  readonly functionsOnlyInB: readonly string[];
  readonly intraMismatches: readonly string[];
  readonly crossDifferences: readonly string[];
  readonly sccDifferences: readonly string[];
}

/**
 * Full structural diff of two catalogs: function set + edges + SCCs. The
 * Phase-4 equivalence gate runs this over (sharded, exact) and asserts every
 * partition empty. Composes the three orthogonal diffs:
 *   - `diffFunctionSets` — occurrence-identity symmetric difference;
 *   - `diffCatalogsByEdge` — the per-edge target diff (intra / cross);
 *   - `diffSccs` — occId-keyed SCC membership diff (reusing the engine's own
 *     `computeSccs` over `buildIndexes`, so the gate measures the SAME SCCs the
 *     `cycle` rule consumes).
 */
export function diffCatalogs(a: Catalog, b: Catalog): CatalogEquivalence {
  const fnDiff = diffFunctionSets(a, b);
  const edgeDiff = diffCatalogsByEdge(a, b);
  const sccDifferences = diffSccs(a, b);
  return {
    functionsOnlyInA: fnDiff.onlyInA,
    functionsOnlyInB: fnDiff.onlyInB,
    intraMismatches: edgeDiff.intraMismatches,
    crossDifferences: edgeDiff.crossDifferences,
    sccDifferences,
  };
}

/** True when every partition of a {@link CatalogEquivalence} is empty. */
export function isEquivalent(eq: CatalogEquivalence): boolean {
  return (
    eq.functionsOnlyInA.length === 0 &&
    eq.functionsOnlyInB.length === 0 &&
    eq.intraMismatches.length === 0 &&
    eq.crossDifferences.length === 0 &&
    eq.sccDifferences.length === 0
  );
}

/**
 * Symmetric difference of the two catalogs' OCCURRENCE IDENTITY sets. Identity
 * is `qualifiedName` when present, else `filePath:line:simpleName` — mirroring
 * the FunctionOccurrence identity model used by `graph-catalog-diff.mjs` and
 * the symbol index, so the in-test gate and the repo-scale diagnostic agree.
 */
function diffFunctionSets(
  a: Catalog,
  b: Catalog,
): { onlyInA: readonly string[]; onlyInB: readonly string[] } {
  const idsA = functionIdentities(a);
  const idsB = functionIdentities(b);
  const onlyInA = [...idsA].filter((id) => !idsB.has(id)).sort();
  const onlyInB = [...idsB].filter((id) => !idsA.has(id)).sort();
  return { onlyInA, onlyInB };
}

/** The set of occurrence identities (`qualifiedName` ?? `filePath:line:name`). */
function functionIdentities(catalog: Catalog): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const [name, occs] of Object.entries(catalog.functions)) {
    if (!occs) continue;
    for (const o of occs) ids.add(occurrenceIdentity(o, name));
  }
  return ids;
}

function occurrenceIdentity(o: FunctionOccurrence, simpleName: string): string {
  return o.qualifiedName.length > 0
    ? o.qualifiedName
    : `${o.filePath}:${String(o.line)}:${simpleName}`;
}

/**
 * Diff the two catalogs' strongly-connected components by SORTED-MEMBER
 * signature. Each SCC is computed via the engine's canonical `computeSccs`
 * (occId-keyed Tarjan) over `buildIndexes(catalog)` — the exact same pass the
 * `cycle` rule's feature column uses — then keyed by its sorted member occIds
 * joined. The result is the symmetric difference of those signatures: a
 * component present in one catalog but not the other (a cycle the two engines
 * disagree on). Singletons are included by `computeSccs` but are stable across
 * engines once the function set matches, so they don't generate noise; only a
 * genuine membership divergence surfaces.
 */
function diffSccs(a: Catalog, b: Catalog): readonly string[] {
  const sigA = sccSignatures(a);
  const sigB = sccSignatures(b);
  const diff = [
    ...[...sigA].filter((s) => !sigB.has(s)),
    ...[...sigB].filter((s) => !sigA.has(s)),
  ];
  return [...new Set(diff)].sort();
}

/** Sorted-member signatures of a catalog's SCCs (the engine's own computation). */
function sccSignatures(catalog: Catalog): ReadonlySet<string> {
  const indexes = buildIndexes(catalog);
  const signatures = new Set<string>();
  for (const scc of computeSccs(indexes)) {
    signatures.add([...scc.members].sort().join('|'));
  }
  return signatures;
}

export interface CatalogEdgeDiff {
  /** Intra-shard edges whose target differs between the two catalogs. MUST be
   *  empty for a correct sharded build vs single-program build. */
  readonly intraMismatches: readonly string[];
  /**
   * Cross-package (boundary-linked) edges whose target differs between the two
   * catalogs. MUST ALSO be empty.
   *
   * With semantic linking (Phase 2), the sharded build's cross-package edges
   * are no longer an approximation of the single-program build's — they are the
   * SAME edges, recovered by linking each import specifier + callee name to the
   * UNIQUE exported occurrence the type checker would pick. A non-empty
   * `crossDifferences` is therefore a correctness REGRESSION (e.g. a name-only
   * fallback fabricating a phantom edge into a package the caller never
   * imported, or the linker declining an edge the single program resolves), NOT
   * an accepted fidelity gap. The Phase 4 equivalence guardrail asserts this
   * partition empty.
   */
  readonly crossDifferences: readonly string[];
}

/**
 * Diff two catalogs by edge, partitioned into intra-shard mismatches and
 * cross-package (boundary-linked) differences. An edge is keyed by
 * `ownerHash@line:col → sorted(to)`; a key is a difference when the two
 * catalogs disagree on its target set. Both partitions MUST be empty for a
 * correct sharded build vs single-program build: intra-package edges are exact
 * in both, and semantic boundary linking reproduces the single-program build's
 * cross-package edges verbatim (Phase 2). The partition only records WHICH side
 * a difference falls on (cross when either edge is `crossShard`), so a
 * regression is attributable to the linker vs a local resolver. The Phase 4
 * equivalence guardrail (`__tests__/equivalence.test.ts`) is the live gate.
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
