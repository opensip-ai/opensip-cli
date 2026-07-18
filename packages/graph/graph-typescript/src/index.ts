/**
 * @opensip-cli/graph — TypeScript language adapter.
 *
 * Lands in PR 3 of plan local planning notes
 * Exposes `typescriptGraphAdapter`, the GraphLanguageAdapter
 * implementation that wraps the existing TypeScript-specific
 * walk/discover/edges machinery into the contract surface defined
 * by `lang-adapter/types.ts`.
 *
 * The contract surface is intentionally small (six methods); each
 * one delegates to the TypeScript-specific implementation and
 * translates I/O shapes:
 *
 *   discoverFiles    → ./discover.ts:discoverFiles
 *   parseProject     → ./parse.ts:parseProject
 *   walkProject      → ./walk.ts:walkProgram, with CallSiteRecord
 *                      translation (node/sourceFile → nodeRef/sourceFileRef)
 *   resolveCallSites → ./edges.ts:resolveEdgesFromRecords
 *   cacheKey         → ./cache-key.ts:cacheKey
 *   ruleHints        → starter list of side-effect primitives + the
 *                      `isTestFile` predicate previously inlined in walk.ts
 *
 * Files outside this subtree are forbidden from importing the
 * TypeScript compiler API directly; the dep-cruiser rule
 * `graph-no-typescript-import-outside-lang-typescript` enforces it.
 */

import { relative, sep } from 'node:path';

import { ownerEdgeKey, resolveSpecifierToPackage } from '@opensip-cli/graph';
import ts from 'typescript';

import { cacheKey as typescriptCacheKey } from './cache-key.js';
import { discoverFiles as discoverTypescriptFiles } from './discover.js';
import {
  buildCrossPackageContext,
  type CrossPackageContext,
} from './edge-helpers/cross-package-context.js';
import { methodTargetFile } from './edge-helpers/method-target.js';
import { extractBoundaryCalls, type MethodTargetResolver } from './edge-resolvers/boundary.js';
import { resolveEdgesFromRecords, resolveEdgesSyntactic } from './edges.js';
import { parseProject as parseTypescriptProject } from './parse.js';
import { collectSemanticReferenceFacts } from './semantic-reference-facts.js';
import { isTypescriptTestFile } from './test-file.js';
import { walkProgram } from './walk.js';

import type { TypescriptFastParsedProject } from './parse-fast.js';
import type { TsParsed, TypescriptParsedProject } from './parse.js';
import type {
  CallSiteRecord as TsCallSiteRecord,
  DependencySiteRecord as TsDependencySiteRecord,
} from './walk.js';
import type {
  CallSiteRecord as ContractCallSiteRecord,
  DependencyClassification,
  DependencyEdge,
  DependencyResolutionBasis,
  DependencySiteRecord as ContractDependencySiteRecord,
  DependencyTargetKind,
  DiscoverInput,
  DiscoverOutput,
  GraphLanguageAdapter,
  PackageManifestIndex,
  ParseInput,
  ParseOutput,
  ResolveInput,
  ResolveOutput,
  WalkInput,
  WalkOutput,
  Catalog,
  CallEdge,
} from '@opensip-cli/graph';

/**
 * Starter list of well-known side-effect primitives for the
 * no-side-effect-path rule. Names are textual prefixes a developer
 * would actually write (e.g. `console.log(`).
 *
 * Conservative: high-precision, low-recall. Adapter authors may
 * extend over time as the rule shows false negatives in practice.
 */
const TYPESCRIPT_SIDE_EFFECT_PRIMITIVES: readonly string[] = [
  'console.log',
  'console.error',
  'console.warn',
  'console.info',
  'console.debug',
  'fs.writeFileSync',
  'fs.appendFileSync',
  'fs.unlinkSync',
  'fs.mkdirSync',
  'fs.rmSync',
  'fs.renameSync',
  'process.exit',
  'process.kill',
  'process.stdout.write',
  'process.stderr.write',
  'Math.random',
  'Date.now',
];

const THROW_SYNTAX_REGEX = /\bthrow\s+(?:new\s+)?[A-Za-z_$]/;

// ── Adapter façade ─────────────────────────────────────────────────

function discoverFilesAdapter(input: DiscoverInput): DiscoverOutput {
  const result = discoverTypescriptFiles({
    projectDir: input.cwd,
    tsConfigPath: input.configPathOverride,
    diagnosticIntent: input.diagnosticIntent,
  });
  return {
    projectDirAbs: result.projectDirAbs,
    files: result.files,
    configPathAbs: result.tsConfigPathAbs,
    compilerOptions: result.compilerOptions,
  };
}

/**
 * Yield the project's source files from either parsed-project tier. The
 * walk is structural and mode-agnostic, so it consumes whichever shape
 * the parse stage produced: exact mode pulls them from the `ts.Program`;
 * fast mode pulls them from the standalone source-file map.
 */
function sourceFilesOf(project: TsParsed): Iterable<ts.SourceFile> {
  return project.kind === 'fast' ? project.sourceFiles.values() : project.program.getSourceFiles();
}

function walkProjectAdapter(input: WalkInput<TsParsed>): WalkOutput {
  const walked = walkProgram({
    sourceFiles: sourceFilesOf(input.project),
    files: input.files,
    projectDirAbs: input.projectDirAbs,
  });
  // Translate the TS-internal CallSiteRecord (node/sourceFile) into the
  // contract's opaque shape (nodeRef/sourceFileRef). No data loss —
  // the same handles flow back into resolveCallSites unchanged.
  const callSites: ContractCallSiteRecord[] = walked.callSites.map((r) => ({
    nodeRef: r.node,
    sourceFileRef: r.sourceFile,
    ownerHash: r.ownerHash,
    ownerLine: r.ownerLine,
    ownerColumn: r.ownerColumn,
    kind: r.kind,
    childHash: r.childHash,
  }));
  const dependencySites: ContractDependencySiteRecord[] = walked.dependencySites.map((r) => ({
    nodeRef: r.node,
    sourceFileRef: r.sourceFile,
    ownerHash: r.ownerHash,
    ownerLine: r.ownerLine,
    ownerColumn: r.ownerColumn,
    specifier: r.specifier,
    line: r.line,
    column: r.column,
    form: r.form,
    role: r.role,
  }));
  return {
    occurrences: walked.functions,
    callSites,
    dependencySites,
    // Re-export facts are pure data (no AST handles) — passed straight through.
    reExports: walked.reExports,
    parseErrors: walked.parseErrors,
  };
}

/**
 * Translate the contract's opaque CallSiteRecord (nodeRef/sourceFileRef)
 * back into the TS-internal shape (real ts.Node / ts.SourceFile handles)
 * that the resolvers and the boundary extractor consume.
 */
/**
 * The TS walk always populates ownerLine/ownerColumn (the contract types them
 * optional only so bare-hash polyglot adapters need not supply a position they
 * don't key on). This round-trip is same-adapter, so they are always present.
 * Fail loud on the impossible absent case rather than defaulting — a `?? default`
 * would silently mismatch the stitch key for any owner not at 1:0.
 *
 * @throws {Error} If `value` is undefined — an invariant violation (the TS walk
 *   always sets owner positions on a same-adapter call-site record).
 */
function requireOwnerPos(value: number | undefined, field: 'ownerLine' | 'ownerColumn'): number {
  if (value === undefined) {
    throw new Error(`graph-typescript: same-adapter call-site record is missing ${field}`);
  }
  return value;
}

function toTsCallSites(callSites: readonly ContractCallSiteRecord[]): TsCallSiteRecord[] {
  return callSites.map((r) => ({
    node: r.nodeRef as ts.Node,
    sourceFile: r.sourceFileRef as ts.SourceFile,
    ownerHash: r.ownerHash,
    ownerLine: requireOwnerPos(r.ownerLine, 'ownerLine'),
    ownerColumn: requireOwnerPos(r.ownerColumn, 'ownerColumn'),
    kind: r.kind,
    childHash: r.childHash,
  }));
}

async function resolveCallSitesAdapter(input: ResolveInput<TsParsed>): Promise<ResolveOutput> {
  // Branch on the parsed-project tier BEFORE touching the checker. The
  // fast tier has no `ts.Program`, so the exact (checker-backed) resolver
  // cannot run on it.
  const base =
    input.project.kind === 'fast'
      ? await resolveCallSitesFast(input, input.project)
      : await resolveCallSitesExact(input, input.project);
  // Sharded build: also emit cross-boundary descriptors for calls that
  // didn't land within this shard's own occurrences. Syntactic and
  // mode-independent, so it runs identically for both tiers.
  if (input.emitBoundaryCalls !== true) return base;
  // Cross-package METHOD calls need a TYPE-attested target file — supply a
  // checker-backed resolver on the exact tier. The fast tier has no `ts.Program`,
  // so method boundary calls are exact-tier only (the equivalence gate runs in
  // exact mode); imported-function boundary calls stay tier-independent.
  let resolveMethodTarget: MethodTargetResolver | undefined;
  if (input.project.kind !== 'fast') {
    const checker = input.project.program.getTypeChecker();
    resolveMethodTarget = (node): string | null =>
      methodTargetFile(node, checker, input.projectDirAbs);
  }
  const boundaryCalls = extractBoundaryCalls(
    toTsCallSites(input.callSites),
    base.edgesByOwner,
    input.projectDirAbs,
    resolveMethodTarget,
  );
  return { ...base, boundaryCalls };
}

async function resolveCallSitesExact(
  input: ResolveInput<TsParsed>,
  project: TypescriptParsedProject,
): Promise<ResolveOutput> {
  const tsCallSites = toTsCallSites(input.callSites);
  // Build the cross-package resolution context ONCE (P2 Phase 0.4) and thread it
  // into BOTH call-edge resolution and dependency resolution — a single manifest
  // read + export-index pass shared across the exact stage (and, from Phase 3,
  // semantic-fact capture), with one canonical fail-closed package attribution.
  const crossPackage = buildCrossPackageContext(input.catalog, input.projectDirAbs);
  const result = await resolveEdgesFromRecords({
    catalog: input.catalog,
    program: project.program,
    projectDirAbs: input.projectDirAbs,
    callSites: tsCallSites,
    crossPackage,
  });

  // Phase 4 (DEC-498): resolve dependency sites if any. Translate
  // back to the TS-specific shape (with real ts.Node handles) and
  // run module resolution.
  // Resolve dependency sites whenever the adapter emitted a (possibly empty)
  // site list. An empty array is "supported, no imports"; `undefined` is
  // "unsupported" and stays `undefined`. (P2 Phase 0 Task 0.1 step 3.)
  let dependenciesByOwner: ReadonlyMap<string, readonly DependencyEdge[]> | undefined;
  if (input.dependencySites !== undefined) {
    dependenciesByOwner = resolveDependencies(
      input.dependencySites.map((r): TsDependencySiteRecord => ({
        node: r.nodeRef as ts.Node,
        sourceFile: r.sourceFileRef as ts.SourceFile,
        ownerHash: r.ownerHash,
        // Always set by the TS walk (see requireOwnerPos) — keep the module-init
        // occurrence position exact for the ownerEdgeKey stitch.
        ownerLine: requireOwnerPos(r.ownerLine, 'ownerLine'),
        ownerColumn: requireOwnerPos(r.ownerColumn, 'ownerColumn'),
        specifier: r.specifier,
        line: r.line,
        column: r.column,
        form: r.form,
        role: r.role,
      })),
      input.catalog,
      project.program,
      input.projectDirAbs,
      crossPackage,
    );
  }

  // Phase 3 semantic declaration/reference plane — exact tier only. Always a
  // present bundle (empty arrays = supported, no facts). Fast mode omits it.
  const discoveredFiles = project.program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile)
    .map((sf) => sf.fileName);
  const semanticFacts = collectSemanticReferenceFacts({
    program: project.program,
    discoveredFiles,
    projectRootAbs: input.projectDirAbs,
    crossPackage,
  });

  return {
    edgesByOwner: collectByOwner(result.catalog),
    dependenciesByOwner,
    semanticFacts,
    stats: result.resolutionStats,
  };
}

/**
 * Fast-tier resolution entry. Resolves call edges syntactically — from
 * callee names and the file's import graph — with NO type checker. The
 * fast parse produced standalone source files (no `ts.Program`), so the
 * semantic resolvers cannot run; `resolveEdgesSyntactic` works purely off
 * the walked records and the catalog.
 *
 * Dependency (module-level import) edges are not emitted in fast mode —
 * they remain an exact-tier feature, so `dependenciesByOwner` is omitted
 * (the contract treats absence as "not emitted by this tier").
 */
async function resolveCallSitesFast(
  input: ResolveInput<TsParsed>,
  _project: TypescriptFastParsedProject,
): Promise<ResolveOutput> {
  const tsCallSites = toTsCallSites(input.callSites);
  const result = await resolveEdgesSyntactic({
    catalog: input.catalog,
    projectDirAbs: input.projectDirAbs,
    callSites: tsCallSites,
  });
  return {
    edgesByOwner: collectByOwner(result.catalog),
    stats: result.resolutionStats,
  };
}

/**
 * Build filePath → module-init bodyHash map from the catalog. Catalog
 * occurrences carry project-relative filePath; only `module-init` kind
 * occurrences participate (they're the receiver of import edges).
 */
function buildModuleInitIndex(catalog: Catalog): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const occs of Object.values(catalog.functions)) {
    if (!occs) continue;
    for (const o of occs) {
      if (o.kind === 'module-init') {
        index.set(o.filePath, o.bodyHash);
      }
    }
  }
  return index;
}

/**
 * Wrap `ts.sys` into a `ModuleResolutionHost`. Methods are bound
 * through arrow functions to satisfy `@typescript-eslint/unbound-method`
 * (arrow `this` is lexical / void). `useCaseSensitiveFileNames` is a
 * boolean property on modern `ts.sys` — the function-vs-boolean branch
 * in earlier code was unreachable dead-code (both branches returned the
 * same value).
 */
function createModuleResolutionHost(): ts.ModuleResolutionHost {
  return {
    fileExists: (fileName: string): boolean => ts.sys.fileExists(fileName),
    readFile: (fileName: string, encoding?: string): string | undefined => {
      return ts.sys.readFile(fileName, encoding);
    },
    directoryExists: (directoryName: string): boolean => ts.sys.directoryExists(directoryName),
    getCurrentDirectory: (): string => ts.sys.getCurrentDirectory(),
    getDirectories: (path: string): string[] => ts.sys.getDirectories(path),
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };
}

/** Bounded resolution of one import site: target hashes plus the classification
 *  axes downstream attribution needs even when there is no callable body hash. */
interface SiteResolution {
  readonly to: readonly string[];
  readonly targetKind: DependencyTargetKind;
  readonly basis: DependencyResolutionBasis;
  readonly reason: string;
  readonly resolvedPackage?: string;
}

/** Compiler + catalog context threaded through one dependency-site resolve. */
interface SiteResolveContext {
  readonly compilerOptions: ts.CompilerOptions;
  readonly moduleResolutionHost: ts.ModuleResolutionHost;
  readonly projectDirAbs: string;
  readonly moduleInitByFilePath: ReadonlyMap<string, string>;
  readonly manifestIndex: PackageManifestIndex;
}

/**
 * Resolve a single import site to a bounded {@link SiteResolution}. A source
 * module-init in the catalog resolves to `catalog-source`; a `.d.ts` entry to
 * `declaration-file`, canonically attributed to a unique workspace package via
 * the manifest index when possible; an installed package to `external`; a
 * relative or otherwise unresolvable target to `unresolved`. External/unresolved
 * sites carry no `resolvedPackage` but stay fully classified (P2 Phase 0).
 */
function resolveSiteTargets(
  site: TsDependencySiteRecord,
  context: SiteResolveContext,
): SiteResolution {
  const {
    compilerOptions,
    moduleResolutionHost,
    projectDirAbs,
    moduleInitByFilePath,
    manifestIndex,
  } = context;
  const resolution = ts.resolveModuleName(
    site.specifier,
    site.sourceFile.fileName,
    compilerOptions,
    moduleResolutionHost,
  );
  const resolved = resolution.resolvedModule;
  if (resolved === undefined) {
    return site.specifier.startsWith('.')
      ? {
          to: [],
          targetKind: 'unresolved',
          basis: 'unresolved',
          reason: 'relative-target-unresolved',
        }
      : {
          to: [],
          targetKind: 'external',
          basis: 'external-specifier',
          reason: 'external-unresolved',
        };
  }

  // Resolved to a source module-init in the callable catalog.
  const projectRel = relative(projectDirAbs, resolved.resolvedFileName).split(sep).join('/');
  const targetHash = moduleInitByFilePath.get(projectRel);
  if (targetHash !== undefined) {
    return {
      to: [targetHash],
      targetKind: 'catalog-source',
      basis: 'catalog-target',
      reason: 'catalog-target',
    };
  }

  // Resolved to a file OUTSIDE the callable catalog.
  const isExternal =
    resolved.isExternalLibraryImport === true ||
    resolved.resolvedFileName.split(sep).join('/').includes('/node_modules/');
  const isDeclaration = /\.d\.[cm]?ts$/.test(resolved.resolvedFileName);

  if (isDeclaration) {
    // The compiler target is a declaration file (e.g. a built workspace
    // `dist/*.d.ts` entry). Attribute to a unique workspace package by manifest.
    const pkg = resolveSpecifierToPackage(site.specifier, manifestIndex);
    if (pkg !== undefined) {
      return {
        to: [],
        targetKind: 'declaration-file',
        basis: 'workspace-manifest',
        reason: 'workspace-declaration-entry',
        resolvedPackage: pkg.packageGroup,
      };
    }
    // A declaration entry that is not a UNIQUE workspace package: an external
    // type package, or a workspace name that is ambiguous/undeclared (the
    // manifest index tombstones duplicates, Task 0.4).
    return isExternal
      ? {
          to: [],
          targetKind: 'external',
          basis: 'external-specifier',
          reason: 'external-declaration',
        }
      : {
          to: [],
          targetKind: 'declaration-file',
          basis: 'unresolved',
          reason: 'workspace-declaration-unmapped',
        };
  }

  if (isExternal) {
    return {
      to: [],
      targetKind: 'external',
      basis: 'external-specifier',
      reason: 'external-package',
    };
  }
  // A real source file that is simply outside the discovered catalog.
  return {
    to: [],
    targetKind: 'unresolved',
    basis: 'unresolved',
    reason: 'target-outside-catalog',
  };
}

/**
 * Build one classified {@link DependencyEdge} from a site + its resolution. The
 * TS walk always sets form+role, so every TS edge is fully classified; the
 * presence check keeps the atomic-classification invariant explicit (a partial
 * classification is never emitted).
 */
function buildDependencyEdge(site: TsDependencySiteRecord, r: SiteResolution): DependencyEdge {
  const classification: DependencyClassification | undefined =
    site.form === undefined || site.role === undefined
      ? undefined
      : {
          form: site.form,
          role: site.role,
          targetKind: r.targetKind,
          basis: r.basis,
          reason: r.reason,
          ...(r.resolvedPackage === undefined ? {} : { resolvedPackage: r.resolvedPackage }),
        };
  return {
    to: r.to,
    line: site.line,
    column: site.column,
    specifier: site.specifier,
    ...(classification === undefined ? {} : { classification }),
  };
}

/**
 * Resolve TS import sites into per-owner {@link DependencyEdge}s carrying the
 * complete {@link DependencyClassification}. EVERY module-init owner is
 * initialized with an empty array first, so a supported file with zero imports
 * persists `dependencies: []` (present-empty) — distinct from an unsupported
 * adapter/tier (map absent). (P2 Phase 0; supersedes DEC-498 v1.)
 */
function resolveDependencies(
  sites: readonly TsDependencySiteRecord[],
  catalog: Catalog,
  program: ts.Program,
  projectDirAbs: string,
  crossPackage: CrossPackageContext,
): ReadonlyMap<string, readonly DependencyEdge[]> {
  const moduleInitByFilePath = buildModuleInitIndex(catalog);
  const compilerOptions = program.getCompilerOptions();
  const moduleResolutionHost = createModuleResolutionHost();
  // Declaration-target attribution reads the SHARED manifest index built once by
  // `resolveCallSitesExact` (P2 Phase 0.4) — the same fail-closed package
  // resolution call-edge resolution used, no second manifest read.
  const manifestIndex = crossPackage.manifestIndex;

  // Initialize every module-init owner to an explicit empty array (Task 0.1 #3).
  const out = new Map<string, DependencyEdge[]>();
  for (const occs of Object.values(catalog.functions)) {
    if (!occs) continue;
    for (const occ of occs) {
      if (occ.kind === 'module-init') {
        out.set(ownerEdgeKey(occ.bodyHash, occ.filePath, occ.line, occ.column), []);
      }
    }
  }

  const resolveContext: SiteResolveContext = {
    compilerOptions,
    moduleResolutionHost,
    projectDirAbs,
    moduleInitByFilePath,
    manifestIndex,
  };
  for (const site of sites) {
    const r = resolveSiteTargets(site, resolveContext);
    const edge = buildDependencyEdge(site, r);
    // Key per owner OCCURRENCE (module-init bodyHash + file + line + column) to
    // match stitchEdges; module-init bodies can collide across trivial files
    // (ADR-0136). The filePath component MUST be POSIX — every sibling key
    // (init loop, stitchEdges, owner-key.ts) uses the occurrence's `/`-separated
    // `filePath`, but `path.relative` yields `\` on Windows.
    const ownerKey = ownerEdgeKey(
      site.ownerHash,
      relative(projectDirAbs, site.sourceFile.fileName).split(sep).join('/'),
      site.ownerLine,
      site.ownerColumn,
    );
    const existing = out.get(ownerKey);
    if (existing === undefined) {
      out.set(ownerKey, [edge]);
    } else {
      existing.push(edge);
    }
  }
  return out;
}

/**
 * Build the `bodyHash → CallEdge[]` map the contract returns.
 * `resolveEdgesFromRecords` writes edges onto a rebuilt catalog; the
 * contract surface separates resolution from catalog mutation, so the
 * orchestrator can stitch the edges into whatever catalog shape it owns.
 */
function collectByOwner(catalog: Catalog): ReadonlyMap<string, readonly CallEdge[]> {
  const out = new Map<string, readonly CallEdge[]>();
  for (const arr of Object.values(catalog.functions)) {
    if (!arr) continue;
    for (const o of arr) {
      if (o.calls.length === 0) continue;
      out.set(ownerEdgeKey(o.bodyHash, o.filePath, o.line, o.column), o.calls);
    }
  }
  return out;
}

export const typescriptGraphAdapter: GraphLanguageAdapter<TsParsed> = {
  id: 'typescript',
  fileExtensions: ['.ts', '.tsx'],
  displayName: 'TypeScript',
  discoverFiles: discoverFilesAdapter,
  parseProject: (input: ParseInput): ParseOutput<TsParsed> => parseTypescriptProject(input),
  walkProject: walkProjectAdapter,
  resolveCallSites: resolveCallSitesAdapter,
  cacheKey: typescriptCacheKey,
  ruleHints: {
    isTestFile: isTypescriptTestFile,
    sideEffectPrimitives: TYPESCRIPT_SIDE_EFFECT_PRIMITIVES,
    throwSyntaxRegex: THROW_SYNTAX_REGEX,
  },
};

/**
 * Discovery contract: external adapter packs export `adapter` (the
 * GraphLanguageAdapter) and `metadata` (a small descriptor used by
 * the CLI for diagnostics). The CLI bootstrap registers `adapter` into
 * the adapter registry after a successful `import()`.
 */
export { typescriptGraphAdapter as adapter };
export const metadata = {
  id: typescriptGraphAdapter.id,
  displayName: typescriptGraphAdapter.displayName,
  fileExtensions: typescriptGraphAdapter.fileExtensions,
} as const;

// Re-export TS-specific helper types so package consumers / tests can
// reference them (these moved out of the engine barrel by PR 1b).
export type { TsParsed, TypescriptParsedProject } from './parse.js';
export type { TypescriptFastParsedProject } from './parse-fast.js';
export type { EdgeResolver, ResolverContext } from './edge-resolvers/types.js';
export type { InventoryVisitor, VisitorContext } from './inventory-visitors/types.js';
export { isTypescriptTestFile } from './test-file.js';
