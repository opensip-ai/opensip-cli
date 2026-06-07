/**
 * Phase 4 equivalence guardrail: the SHARDED build must equal the
 * SINGLE-PROGRAM build on a committed multi-package fixture — for BOTH
 * intra- and cross-package edges — with the `canonicalize`-style phantom as a
 * named regression case.
 *
 * The fixture (`../__fixtures__/multi-pkg`) is three tiny workspace packages:
 *   - @fixture/a       — `main` calls `@fixture/foundation.canonicalize` (bare
 *                        workspace specifier → genuine cross-package edge) and
 *                        `./local.formatLocal` (relative → intra-package edge).
 *   - @fixture/foundation — `canonicalize` is self-recursive (the leaf-util case).
 *   - @fixture/b       — ALSO exports `canonicalize`, which pkg-a NEVER imports.
 *                        A name-only resolver would link pkg-a → b.canonicalize:
 *                        the phantom trap this gate catches.
 *
 * We build the SAME files two ways through the REAL engine pipeline:
 *   single-program → one `buildAndResolveCatalog` over ALL fixture files;
 *   sharded        → one `buildAndResolveCatalog` per package (emitting
 *                    boundary calls) merged + linked by `mergeAndResolveShards`.
 * Then `diffCatalogsByEdge(sharded, singleProgram)` must report BOTH partitions
 * empty. A test-local fixture-driven adapter supplies the occurrences / call
 * sites / import specifiers (the engine layer cannot import a real TS adapter);
 * its cross-package resolution reuses the SAME engine helpers the linker uses
 * (`resolveSpecifierToPackage` + `buildExportIndex`), so the single-program
 * oracle and the sharded linker agree by construction — and both decline the
 * phantom.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ownerEdgeKey } from '../../../owner-key.js';
import { buildAndResolveCatalog } from '../catalog-builder.js';
import { diffCatalogsByEdge, mergeAndResolveShards } from '../cross-shard-resolve.js';
import { buildExportIndex, buildPackageManifestIndex, resolveSpecifierToPackage } from '../export-index.js';

import type {
  CallSiteRecord,
  DiscoverInput,
  DiscoverOutput,
  GraphLanguageAdapter,
  ParseInput,
  ParseOutput,
  ResolveInput,
  ResolveOutput,
  WalkInput,
  WalkOutput,
} from '../../../lang-adapter/types.js';
import type {
  CallEdge,
  Catalog,
  CrossBoundaryCall,
  FunctionOccurrence,
} from '../../../types.js';
import type { RunStage } from '../catalog-builder.js';
import type { PackageManifestIndex } from '../export-index.js';
import type { Shard, ShardBuildResult } from '../shard-model.js';

// ── fixture geography ─────────────────────────────────────────────

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '__fixtures__',
  'multi-pkg',
);

/** The three package roots (absolute) — one shard each. */
const PKG_DIRS = {
  a: join(FIXTURE_ROOT, 'packages', 'a'),
  foundation: join(FIXTURE_ROOT, 'packages', 'foundation'),
  b: join(FIXTURE_ROOT, 'packages', 'b'),
} as const;

/** Every fixture `.ts` source, absolute, grouped by package. */
const PKG_FILES: Record<keyof typeof PKG_DIRS, readonly string[]> = {
  a: [join(PKG_DIRS.a, 'src', 'main.ts'), join(PKG_DIRS.a, 'src', 'local.ts')],
  foundation: [join(PKG_DIRS.foundation, 'src', 'canonicalize.ts')],
  b: [join(PKG_DIRS.b, 'src', 'util.ts')],
};

const ALL_FILES: readonly string[] = Object.values(PKG_FILES).flat();

function toProjectRel(absFile: string): string {
  const rel = relative(FIXTURE_ROOT, absFile);
  return sep === '/' ? rel : rel.split(sep).join('/');
}

function bodyHashFor(projectRel: string, name: string): string {
  return createHash('sha256').update(`${projectRel}#${name}`).digest('hex').slice(0, 16);
}

// ── a deterministic, fixture-driven graph adapter ─────────────────
//
// Reads the committed `.ts` source as text and extracts exactly what the
// equivalence pipeline needs: exported functions, their call sites, and the
// import binding (specifier) each callee name arrived through. It exercises the
// REAL engine path (buildAndResolveCatalog → mergeAndResolveShards →
// diffCatalogsByEdge) without an in-tree TypeScript parser the engine layer is
// not allowed to import.

/** One parsed fixture file. */
interface ParsedFile {
  readonly projectRel: string;
  /** exported function name → { line, column } of its declaration. */
  readonly exports: Map<string, { line: number; column: number }>;
  /** imported callee name → its import specifier (bare or relative). */
  readonly importsByName: Map<string, string>;
  /** call sites inside the file, attributed to their enclosing exported fn. */
  readonly callSites: readonly ParsedCall[];
}

interface ParsedCall {
  readonly ownerName: string;
  readonly calleeName: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

// Identifier = `[A-Za-z_]\w{0,80}` with NO `\s*` before `(` — the fixture
// writes parens flush to the name. The bounded `\w{0,80}` is delimited by the
// literal `(`, so there is no backtracking / ReDoS exposure.
const EXPORT_FN_RE = /export\s+function\s+([A-Za-z_]\w{0,80})\(/;
const CALL_RE = /([A-Za-z_]\w{0,80})\(/g;

/**
 * Parse `import { a, b } from 'spec'` into the bound names + specifier without
 * a backtracking-prone regex (linear `indexOf`/`slice` scan over the line).
 * Returns `undefined` for non-named-import lines.
 */
function parseImportLine(line: string): { names: string[]; specifier: string } | undefined {
  const open = line.indexOf('{');
  const close = line.indexOf('}');
  const from = line.indexOf('from', close);
  if (!line.includes('import') || open === -1 || close < open || from === -1) return undefined;
  const specifier = extractQuoted(line.slice(from));
  if (specifier === undefined) return undefined;
  const names = line
    .slice(open + 1, close)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { names, specifier };
}

/** The text between the first quote (`'` or `"`) and its matching close. */
function extractQuoted(s: string): string | undefined {
  const q = s.search(/['"]/);
  if (q === -1) return undefined;
  const end = s.indexOf(s[q] ?? '"', q + 1);
  return end === -1 ? undefined : s.slice(q + 1, end);
}

/** Parse one fixture file into the occurrence / call / import model. */
function parseFixtureFile(absFile: string): ParsedFile {
  const projectRel = toProjectRel(absFile);
  const text = readFileSync(absFile, 'utf8');
  const lines = text.split('\n');

  const exports = new Map<string, { line: number; column: number }>();
  const importsByName = new Map<string, string>();
  const callSites: ParsedCall[] = [];

  let currentOwner: string | undefined;
  for (const [i, rawLine] of lines.entries()) {
    const line = i + 1;
    const imported = parseImportLine(rawLine);
    if (imported !== undefined) {
      for (const name of imported.names) importsByName.set(name, imported.specifier);
      continue;
    }
    const exportMatch = EXPORT_FN_RE.exec(rawLine);
    if (exportMatch?.[1] !== undefined) {
      currentOwner = exportMatch[1];
      const column = rawLine.indexOf('function');
      exports.set(currentOwner, { line, column });
      continue; // the declaration line's own `name(` is the signature, not a call
    }
    if (currentOwner === undefined) continue;
    for (const callMatch of rawLine.matchAll(CALL_RE)) {
      const calleeName = callMatch[1];
      if (calleeName === undefined) continue;
      const keyword = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function']);
      if (keyword.has(calleeName)) continue;
      callSites.push({
        ownerName: currentOwner,
        calleeName,
        line,
        column: callMatch.index ?? 0,
        text: `${calleeName}()`,
      });
    }
  }
  return { projectRel, exports, importsByName, callSites };
}

/** Internal parse state the adapter threads parse → walk → resolve. */
interface FixtureProject {
  readonly files: readonly ParsedFile[];
}

const KEYWORD_CALLS = new Set(['map']); // array helpers we don't model as fn edges

function makeFixtureAdapter(): GraphLanguageAdapter<FixtureProject> {
  return {
    id: 'typescript',
    fileExtensions: ['.ts'],
    displayName: 'fixture-ts',

    discoverFiles(input: DiscoverInput): DiscoverOutput {
      // Files are supplied explicitly via the catalog-build options; discovery
      // only needs to echo the project root.
      return { projectDirAbs: input.cwd, files: [] };
    },

    parseProject(input: ParseInput): ParseOutput<FixtureProject> {
      const files = input.files.map((f) => parseFixtureFile(f));
      return { project: { files }, parseErrors: [] };
    },

    walkProject(input: WalkInput<FixtureProject>): WalkOutput {
      const occurrences: Record<string, FunctionOccurrence[]> = {};
      const callSites: CallSiteRecord[] = [];
      for (const file of input.project.files) {
        for (const [name, pos] of file.exports) {
          const occ = makeOccurrence(file.projectRel, name, pos.line, pos.column);
          const bucket = occurrences[name] ?? [];
          bucket.push(occ);
          occurrences[name] = bucket;
        }
        for (const call of file.callSites) {
          if (KEYWORD_CALLS.has(call.calleeName)) continue;
          callSites.push({
            // nodeRef/sourceFileRef carry the resolution facts this fixture
            // adapter needs; the engine treats them as opaque handles.
            nodeRef: { file, call },
            sourceFileRef: file,
            ownerHash: bodyHashFor(file.projectRel, call.ownerName),
            kind: 'call',
          });
        }
      }
      return { occurrences, callSites, parseErrors: [] };
    },

    resolveCallSites(input: ResolveInput<FixtureProject>): ResolveOutput {
      return resolveFixtureEdges(input);
    },

    cacheKey: () => 'fixture-key',
    ruleHints: undefined,
  };
}

function makeOccurrence(
  projectRel: string,
  name: string,
  line: number,
  column: number,
): FunctionOccurrence {
  return {
    bodyHash: bodyHashFor(projectRel, name),
    simpleName: name,
    qualifiedName: `${projectRel}.${name}`,
    filePath: projectRel,
    line,
    column,
    endLine: line,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'exported',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
  };
}

/**
 * Resolve every call site to a CallEdge, mirroring the cross-shard linker:
 *   - callee defined in the SAME file              → static intra-file edge;
 *   - callee imported via a RELATIVE specifier     → path-pin to the target file;
 *   - callee imported via a BARE workspace specifier:
 *       sharded (emitBoundaryCalls): NOT in this build's files → boundary call;
 *       single-program: resolve to the unique export of the named package.
 * Declines (empty `to`) on ambiguity — never name-only guesses (the phantom).
 */
function resolveFixtureEdges(input: ResolveInput<FixtureProject>): ResolveOutput {
  const exportIndex = buildExportIndex(input.catalog);
  // All three package manifests are always in scope: even a single-package
  // shard must resolve the bare specifier `@fixture/foundation` to a package
  // group (the imported package's own occurrences may be absent from THIS
  // shard — that's exactly when the call becomes a boundary call).
  const manifestIndex = buildPackageManifestIndex(FIXTURE_SHARDS, FIXTURE_ROOT);
  const fileByRel = new Map(input.project.files.map((f) => [f.projectRel, f]));

  const edgesByOwner = new Map<string, CallEdge[]>();
  const boundaryCalls: CrossBoundaryCall[] = [];
  let resolvedHigh = 0;
  let unresolved = 0;
  let totalCallSites = 0;

  for (const site of input.callSites) {
    const { file, call } = site.nodeRef as { file: ParsedFile; call: ParsedCall };
    totalCallSites++;
    // The engine stitches local edges back by (bodyHash, filePath) — boundary
    // edges by bodyHash alone — so a body-twin's edges never union.
    const ownerKey = ownerEdgeKey(site.ownerHash, file.projectRel);
    const spec = importSpecifierFor(file, call.calleeName);
    const target = resolveOne(call, file, spec, {
      exportIndex,
      manifestIndex,
      fileByRel,
      emitBoundaryCalls: input.emitBoundaryCalls ?? false,
    });
    if (target.boundary) {
      boundaryCalls.push({
        ownerHash: site.ownerHash,
        calleeName: call.calleeName,
        importSpecifier: spec,
        line: call.line,
        column: call.column,
        text: call.text,
      });
      appendEdge(edgesByOwner, ownerKey, {
        to: [],
        line: call.line,
        column: call.column,
        resolution: 'unknown',
        confidence: 'low',
        text: call.text,
      });
      continue;
    }
    const edge: CallEdge = {
      to: target.to,
      line: call.line,
      column: call.column,
      resolution: target.to.length > 0 ? 'static' : 'unknown',
      confidence: target.to.length > 0 ? 'high' : 'low',
      text: call.text,
    };
    appendEdge(edgesByOwner, ownerKey, edge);
    if (target.to.length > 0) resolvedHigh++;
    else unresolved++;
  }

  return {
    edgesByOwner,
    boundaryCalls,
    stats: { totalCallSites, resolvedHigh, resolvedMedium: 0, resolvedLow: 0, unresolved },
  };
}

interface ResolveCtx {
  readonly exportIndex: ReturnType<typeof buildExportIndex>;
  readonly manifestIndex: PackageManifestIndex;
  readonly fileByRel: ReadonlyMap<string, ParsedFile>;
  readonly emitBoundaryCalls: boolean;
}

/** Either a resolved edge target, or a flag to defer to the cross-shard pass. */
type Resolution = { boundary: true } | { boundary: false; to: readonly string[] };

function resolveOne(
  call: ParsedCall,
  file: ParsedFile,
  spec: string | undefined,
  ctx: ResolveCtx,
): Resolution {
  // (1) Same-file definition (e.g. canonicalize calling itself).
  if (file.exports.has(call.calleeName)) {
    return { boundary: false, to: [bodyHashFor(file.projectRel, call.calleeName)] };
  }
  // (2) Relative import → path-pin to the resolved file (intra-package).
  if (spec?.startsWith('.')) {
    const targetRel = resolveRelative(file.projectRel, spec);
    const targetFile = ctx.fileByRel.get(targetRel);
    if (targetFile?.exports.has(call.calleeName)) {
      return { boundary: false, to: [bodyHashFor(targetRel, call.calleeName)] };
    }
    return { boundary: false, to: [] };
  }
  // (3) Bare workspace specifier → resolve the named package's unique export.
  if (spec === undefined) return { boundary: false, to: [] };
  const resolved = resolveSpecifierToPackage(spec, ctx.manifestIndex);
  if (resolved === undefined) return { boundary: false, to: [] };
  const exported = ctx.exportIndex.get(resolved.packageGroup)?.get(call.calleeName) ?? [];
  // In sharded mode the imported package's occurrences are absent from THIS
  // shard's catalog → defer to the cross-shard linker. In single-program mode
  // they are present → resolve directly (the oracle).
  if (ctx.emitBoundaryCalls && exported.length === 0) return { boundary: true };
  if (exported.length !== 1) return { boundary: false, to: [] }; // ambiguous / absent → decline
  const only = exported[0];
  return only === undefined ? { boundary: false, to: [] } : { boundary: false, to: [only.bodyHash] };
}

function importSpecifierFor(file: ParsedFile, name: string): string | undefined {
  return file.importsByName.get(name);
}

function resolveRelative(ownerRel: string, spec: string): string {
  const stripped = spec.replace(/\.js$/, '.ts');
  return posix.normalize(posix.join(posix.dirname(ownerRel), stripped));
}

function appendEdge(map: Map<string, CallEdge[]>, owner: string, edge: CallEdge): void {
  const bucket = map.get(owner);
  if (bucket) bucket.push(edge);
  else map.set(owner, [edge]);
}

/** The three package shards — one per workspace package. */
const FIXTURE_SHARDS: readonly Shard[] = [
  { id: 'pkg:a', rootDir: PKG_DIRS.a, files: [...PKG_FILES.a] },
  { id: 'pkg:foundation', rootDir: PKG_DIRS.foundation, files: [...PKG_FILES.foundation] },
  { id: 'pkg:b', rootDir: PKG_DIRS.b, files: [...PKG_FILES.b] },
];

// ── build the catalog two ways through the real engine ────────────

/** A trivial runStage: just await the stage work (no live view, no spans). */
const runStage: RunStage = async (args) => args.fn();

async function buildSingleProgram(): Promise<Catalog> {
  const adapter = makeFixtureAdapter();
  const built = await buildAndResolveCatalog({
    runStage,
    adapter,
    discovery: { projectDirAbs: FIXTURE_ROOT, files: ALL_FILES },
    resolutionMode: 'exact',
  });
  return built.catalog;
}

async function buildSharded(): Promise<Catalog> {
  const adapter = makeFixtureAdapter();
  const fragments: ShardBuildResult[] = [];
  for (const shard of FIXTURE_SHARDS) {
    const built = await buildAndResolveCatalog({
      runStage,
      adapter,
      discovery: { projectDirAbs: FIXTURE_ROOT, files: shard.files },
      resolutionMode: 'exact',
      emitBoundaryCalls: true,
    });
    fragments.push({
      shardId: shard.id,
      fragment: built.catalog,
      fingerprint: `fp-${shard.id}`,
      boundaryCalls: built.boundaryCalls ?? [],
      parseErrors: built.parseErrors,
    });
  }
  const manifestIndex = buildPackageManifestIndex(FIXTURE_SHARDS, FIXTURE_ROOT);
  return mergeAndResolveShards(fragments, ALL_FILES, manifestIndex).catalog;
}

// ── edge-lookup helpers for the named assertions ──────────────────

const FOUNDATION_CANON = bodyHashFor('packages/foundation/src/canonicalize.ts', 'canonicalize');
const B_CANON = bodyHashFor('packages/b/src/util.ts', 'canonicalize');
const A_LOCAL = bodyHashFor('packages/a/src/local.ts', 'formatLocal');

function mainEdges(catalog: Catalog): readonly CallEdge[] {
  return catalog.functions.main?.[0]?.calls ?? [];
}

function targetsOf(catalog: Catalog): readonly string[] {
  return mainEdges(catalog).flatMap((e) => [...e.to]);
}

/** Sorted, deduped set of project-relative file paths present in a catalog. */
function filesOf(catalog: Catalog): string[] {
  return [...new Set(Object.values(catalog.functions).flat().map((o) => o.filePath))].sort();
}

// ── the gate ──────────────────────────────────────────────────────

describe('exact-sharding equivalence guardrail', () => {
  it('sharded build equals single-program build on BOTH intra- and cross-package edges', async () => {
    const singleProgram = await buildSingleProgram();
    const sharded = await buildSharded();

    const diff = diffCatalogsByEdge(sharded, singleProgram);

    // Intra-package edges must already match (Phase 0/Phase 2 invariant)…
    expect(diff.intraMismatches).toEqual([]);
    // …and with semantic linking, cross-package edges must match too: a
    // non-empty crossDifferences is a correctness regression (Phase 4).
    expect(diff.crossDifferences).toEqual([]);
  });

  it('builds the two catalogs over the same project-relative file set', async () => {
    const singleProgram = await buildSingleProgram();
    const sharded = await buildSharded();
    expect(filesOf(sharded)).toEqual(filesOf(singleProgram));
  });

  it('keeps the genuine pkg-a → foundation.canonicalize cross-package edge', async () => {
    const sharded = await buildSharded();
    expect(targetsOf(sharded)).toContain(FOUNDATION_CANON);
    // And it is recovered as a semantic cross-shard edge in the sharded build.
    const edge = mainEdges(sharded).find((e) => e.to.includes(FOUNDATION_CANON));
    expect(edge?.crossShard).toBe(true);
    expect(edge?.resolution).toBe('semantic');
  });

  it('NEVER links the phantom pkg-a → b.canonicalize (name-collision trap)', async () => {
    const singleProgram = await buildSingleProgram();
    const sharded = await buildSharded();
    expect(targetsOf(singleProgram)).not.toContain(B_CANON);
    expect(targetsOf(sharded)).not.toContain(B_CANON);
  });

  it('keeps the relative intra-package edge pkg-a main → ./local.formatLocal', async () => {
    const sharded = await buildSharded();
    const singleProgram = await buildSingleProgram();
    expect(targetsOf(sharded)).toContain(A_LOCAL);
    expect(targetsOf(singleProgram)).toContain(A_LOCAL);
  });

  it('preserves the self-recursive foundation.canonicalize edge', async () => {
    const sharded = await buildSharded();
    const selfCalls = sharded.functions.canonicalize?.find(
      (o) => o.filePath === 'packages/foundation/src/canonicalize.ts',
    )?.calls;
    expect(selfCalls?.some((e) => e.to.includes(FOUNDATION_CANON))).toBe(true);
  });

  // ── the gate has teeth (regression-detector guard) ──────────────
  //
  // The two assertions above prove the SHIPPING semantic linker agrees with the
  // single-program oracle (crossDifferences empty) and declines the phantom.
  // This pair proves the gate would actually FAIL if the linker regressed — that
  // the empty `crossDifferences` is a real signal, not a vacuous pass. We do NOT
  // revert production code (CLAUDE.md / Phase 4): instead we synthesize the two
  // canonical regressions on a COPY of the real sharded catalog and assert
  // `diffCatalogsByEdge` lands them in `crossDifferences`.

  it('FAILS the gate if the linker degrades to a name-only phantom (b.canonicalize)', async () => {
    const singleProgram = await buildSingleProgram();
    const sharded = await buildSharded();

    // Sanity: the honest sharded build matches the oracle (the gate's green case).
    expect(diffCatalogsByEdge(sharded, singleProgram).crossDifferences).toEqual([]);

    // Simulate the OLD name-only fallback: at main's genuine cross-package edge,
    // swap the target from foundation.canonicalize → b.canonicalize (the phantom
    // a name-only resolver fabricates by matching the globally-unique-ish simple
    // name into a package pkg-a never imported).
    const degraded = rewriteCrossEdgeTarget(sharded, FOUNDATION_CANON, B_CANON);
    expect(targetsOf(degraded)).toContain(B_CANON); // the phantom is now present

    const diff = diffCatalogsByEdge(degraded, singleProgram);
    expect(diff.crossDifferences.length).toBeGreaterThan(0); // gate catches it
  });

  it('FAILS the gate if the linker DROPS the genuine cross-package edge', async () => {
    const singleProgram = await buildSingleProgram();
    const sharded = await buildSharded();

    // The other regression direction: the linker declines an edge the single
    // program resolves (e.g. it stopped following the bare-specifier export
    // link). Clear main's cross-package target → an empty `to` at that site.
    const dropped = rewriteCrossEdgeTarget(sharded, FOUNDATION_CANON, undefined);
    expect(targetsOf(dropped)).not.toContain(FOUNDATION_CANON);

    const diff = diffCatalogsByEdge(dropped, singleProgram);
    expect(diff.crossDifferences.length).toBeGreaterThan(0); // gate catches it
  });
});

/**
 * Return a COPY of `catalog` in which every cross-shard edge whose target set
 * contains `from` has it replaced by `to` (or removed when `to === undefined`).
 * Used ONLY by the regression-detector guards to synthesize a degraded linker
 * output without touching production resolution code.
 */
function rewriteCrossEdgeTarget(
  catalog: Catalog,
  from: string,
  to: string | undefined,
): Catalog {
  const functions: Record<string, FunctionOccurrence[]> = {};
  for (const [name, occs] of Object.entries(catalog.functions)) {
    if (!occs) continue;
    functions[name] = occs.map((o) => ({
      ...o,
      calls: o.calls.map((e) =>
        e.crossShard && e.to.includes(from)
          ? { ...e, to: to === undefined ? [] : e.to.map((t) => (t === from ? to : t)) }
          : e,
      ),
    }));
  }
  return { ...catalog, functions };
}
