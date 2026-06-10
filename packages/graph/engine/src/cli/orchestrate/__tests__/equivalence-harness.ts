/**
 * Shared equivalence harness — a deterministic, fixture-driven graph adapter +
 * the two-engine build helpers, parameterized by fixture geography.
 *
 * Both the small multi-pkg gate (`equivalence.test.ts`) and the medium-repo
 * oracle (`equivalence-repo-scale.test.ts`) build their fixtures through the
 * SAME real engine pipeline (`buildAndResolveCatalog` → `mergeAndResolveShards`)
 * using this one adapter — so there is exactly one fixture-resolution model,
 * never two drifting copies. The engine layer may not import a real TypeScript
 * adapter, so this reads each committed `.ts` source as text and extracts only
 * what the equivalence pipeline needs: exported functions, their call sites, and
 * the import binding (specifier) each callee name arrived through.
 *
 * Its cross-package resolution reuses the SAME engine helpers the production
 * linker uses (`resolveSpecifierToPackage` + `buildExportIndex`), so the
 * single-program oracle and the sharded linker agree by construction — and both
 * decline name-collision phantoms.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix, relative, sep } from 'node:path';

import {
  buildExportIndex,
  buildPackageManifestIndex,
  resolveSpecifierToPackage,
} from '../../../cross-package/export-index.js';
import { ownerEdgeKey } from '../../../owner-key.js';
import { buildAndResolveCatalog } from '../catalog-builder.js';
import { mergeAndResolveShards } from '../cross-shard-resolve.js';

import type { PackageManifestIndex } from '../../../cross-package/export-index.js';
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
import type { CallEdge, Catalog, CrossBoundaryCall, FunctionOccurrence } from '../../../types.js';
import type { RunStage } from '../catalog-builder.js';
import type { Shard, ShardBuildResult } from '../shard-model.js';

// ── parsed-fixture model ──────────────────────────────────────────

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

/** Internal parse state the adapter threads parse → walk → resolve. */
interface FixtureProject {
  readonly files: readonly ParsedFile[];
}

// Identifier = `[A-Za-z_]\w{0,80}` with NO `\s*` before `(` — fixtures write
// parens flush to the name. The bounded `\w{0,80}` is delimited by the literal
// `(`, so there is no backtracking / ReDoS exposure.
const EXPORT_FN_RE = /export\s+function\s+([A-Za-z_]\w{0,80})\(/;
const CALL_RE = /([A-Za-z_]\w{0,80})\(/g;
const KEYWORD_CALLS = new Set(['map']); // array helpers we don't model as fn edges
const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function']);

// ── public harness API ────────────────────────────────────────────

/** Fixture geography a harness instance resolves against. */
export interface HarnessConfig {
  /** Absolute fixture root — paths are relativized against it for identity. */
  readonly fixtureRoot: string;
  /** The shard partition (one per workspace package + the `:root` shard). */
  readonly shards: readonly Shard[];
  /** Every fixture `.ts` source (absolute) — the single-program file set. */
  readonly allFiles: readonly string[];
}

/**
 * What `createEquivalenceHarness` returns: identity helpers + two-engine builds.
 * Members are arrow-typed properties (not method shorthand) so consumers can
 * destructure them without tripping `@typescript-eslint/unbound-method`.
 */
export interface EquivalenceHarness {
  /** Stable bodyHash for an occurrence — `sha256(projectRel#name)` (16 hex). */
  readonly bodyHashFor: (projectRel: string, name: string) => string;
  /** Project-relative POSIX path for an absolute fixture file. */
  readonly toProjectRel: (absFile: string) => string;
  /** Build ONE catalog over ALL files (the exact / single-program engine). */
  readonly buildSingleProgram: () => Promise<Catalog>;
  /** Build per-shard fragments + merge/link them (the sharded engine). */
  readonly buildSharded: () => Promise<Catalog>;
}

/** A trivial runStage: just await the stage work (no live view, no spans). */
const runStage: RunStage = async (args) => args.fn();

/** Stable bodyHash for an occurrence — `sha256(projectRel#name)` (16 hex). Pure,
 *  so it lives at module scope (closes over nothing). */
function bodyHashFor(projectRel: string, name: string): string {
  return createHash('sha256').update(`${projectRel}#${name}`).digest('hex').slice(0, 16);
}

/** Build a harness bound to one fixture's geography. */
export function createEquivalenceHarness(config: HarnessConfig): EquivalenceHarness {
  const { fixtureRoot, shards, allFiles } = config;

  const toProjectRel = (absFile: string): string => {
    const rel = relative(fixtureRoot, absFile);
    return sep === '/' ? rel : rel.split(sep).join('/');
  };

  const adapter = makeFixtureAdapter({ fixtureRoot, shards, toProjectRel, bodyHashFor });

  const buildSingleProgram = async (): Promise<Catalog> => {
    const built = await buildAndResolveCatalog({
      runStage,
      adapter,
      discovery: { projectDirAbs: fixtureRoot, files: allFiles },
      resolutionMode: 'exact',
    });
    return built.catalog;
  };

  const buildSharded = async (): Promise<Catalog> => {
    const fragments: ShardBuildResult[] = [];
    for (const shard of shards) {
      const built = await buildAndResolveCatalog({
        runStage,
        adapter,
        discovery: { projectDirAbs: fixtureRoot, files: shard.files },
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
    const manifestIndex = buildPackageManifestIndex(shards, fixtureRoot);
    return mergeAndResolveShards(fragments, allFiles, manifestIndex).catalog;
  };

  return { bodyHashFor, toProjectRel, buildSingleProgram, buildSharded };
}

// ── adapter internals ─────────────────────────────────────────────

interface AdapterDeps {
  readonly fixtureRoot: string;
  readonly shards: readonly Shard[];
  readonly toProjectRel: (absFile: string) => string;
  readonly bodyHashFor: (projectRel: string, name: string) => string;
}

function makeFixtureAdapter(deps: AdapterDeps): GraphLanguageAdapter<FixtureProject> {
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
      const files = input.files.map((f) => parseFixtureFile(f, deps.toProjectRel));
      return { project: { files }, parseErrors: [] };
    },

    walkProject(input: WalkInput<FixtureProject>): WalkOutput {
      const occurrences: Record<string, FunctionOccurrence[]> = {};
      const callSites: CallSiteRecord[] = [];
      for (const file of input.project.files) {
        for (const [name, pos] of file.exports) {
          const occ = makeOccurrence(file.projectRel, name, pos.line, pos.column, deps.bodyHashFor);
          const bucket = occurrences[name] ?? [];
          bucket.push(occ);
          occurrences[name] = bucket;
        }
        for (const call of file.callSites) {
          if (KEYWORD_CALLS.has(call.calleeName)) continue;
          callSites.push({
            nodeRef: { file, call },
            sourceFileRef: file,
            ownerHash: deps.bodyHashFor(file.projectRel, call.ownerName),
            kind: 'call',
          });
        }
      }
      return { occurrences, callSites, parseErrors: [] };
    },

    resolveCallSites(input: ResolveInput<FixtureProject>): ResolveOutput {
      return resolveFixtureEdges(input, deps);
    },

    cacheKey: () => 'fixture-key',
    ruleHints: undefined,
  };
}

/** Parse `import { a, b } from 'spec'` into the bound names + specifier. */
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
function parseFixtureFile(absFile: string, toProjectRel: (f: string) => string): ParsedFile {
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
      if (calleeName === undefined || CONTROL_KEYWORDS.has(calleeName)) continue;
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

function makeOccurrence(
  projectRel: string,
  name: string,
  line: number,
  column: number,
  bodyHashFor: (projectRel: string, name: string) => string,
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
function resolveFixtureEdges(
  input: ResolveInput<FixtureProject>,
  deps: AdapterDeps,
): ResolveOutput {
  const exportIndex = buildExportIndex(input.catalog);
  // ALL package manifests are always in scope: even a single-package shard must
  // resolve a bare specifier to a package group (the imported package's own
  // occurrences may be absent from THIS shard — when the call becomes boundary).
  const manifestIndex = buildPackageManifestIndex(deps.shards, deps.fixtureRoot);
  const fileByRel = new Map(input.project.files.map((f) => [f.projectRel, f]));

  const edgesByOwner = new Map<string, CallEdge[]>();
  const boundaryCalls: CrossBoundaryCall[] = [];
  let resolvedHigh = 0;
  let unresolved = 0;
  let totalCallSites = 0;

  for (const site of input.callSites) {
    const { file, call } = site.nodeRef as { file: ParsedFile; call: ParsedCall };
    totalCallSites++;
    // The engine stitches BOTH local AND boundary edges back by
    // ownerEdgeKey(bodyHash, filePath) — so a body-twin's edges never union
    // (ADR-0003). The boundary descriptor carries `ownerFile` for exactly this.
    const ownerKey = ownerEdgeKey(site.ownerHash, file.projectRel);
    const spec = file.importsByName.get(call.calleeName);
    const target = resolveOne(call, file, spec, {
      exportIndex,
      manifestIndex,
      fileByRel,
      emitBoundaryCalls: input.emitBoundaryCalls ?? false,
      bodyHashFor: deps.bodyHashFor,
    });
    if (target.boundary) {
      boundaryCalls.push({
        ownerHash: site.ownerHash,
        ownerFile: file.projectRel,
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
  readonly bodyHashFor: (projectRel: string, name: string) => string;
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
    return { boundary: false, to: [ctx.bodyHashFor(file.projectRel, call.calleeName)] };
  }
  // (2) Relative import → path-pin to the resolved file (intra-package).
  if (spec?.startsWith('.')) {
    const targetRel = resolveRelative(file.projectRel, spec);
    const targetFile = ctx.fileByRel.get(targetRel);
    if (targetFile?.exports.has(call.calleeName)) {
      return { boundary: false, to: [ctx.bodyHashFor(targetRel, call.calleeName)] };
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
  return only === undefined
    ? { boundary: false, to: [] }
    : { boundary: false, to: [only.bodyHash] };
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
