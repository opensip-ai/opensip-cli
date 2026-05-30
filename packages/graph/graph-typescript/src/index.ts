// @fitness-ignore-file unbounded-memory -- reads single source files for parsing; per-file memory bounded by source size
/**
 * @opensip-tools/graph — TypeScript language adapter.
 *
 * Lands in PR 3 of plan docs/plans/10-graph-language-pluggability.md.
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

import ts from 'typescript';

import { cacheKey as typescriptCacheKey } from './cache-key.js';
import { discoverFiles as discoverTypescriptFiles } from './discover.js';
import { resolveEdgesFromRecords } from './edges.js';
import { parseProject as parseTypescriptProject } from './parse.js';
import { isTypescriptTestFile } from './test-file.js';
import { walkProgram } from './walk.js';



import type { TypescriptParsedProject } from './parse.js';
import type {
  CallSiteRecord as TsCallSiteRecord,
  DependencySiteRecord as TsDependencySiteRecord,
} from './walk.js';
import type {
  CallSiteRecord as ContractCallSiteRecord,
  DependencyEdge,
  DependencySiteRecord as ContractDependencySiteRecord,
  DiscoverInput,
  DiscoverOutput,
  GraphLanguageAdapter,
  ParseInput,
  ParseOutput,
  ResolveInput,
  ResolveOutput,
  WalkInput,
  WalkOutput,
  Catalog,
  CallEdge,
} from '@opensip-tools/graph';


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
  });
  return {
    projectDirAbs: result.projectDirAbs,
    files: result.files,
    configPathAbs: result.tsConfigPathAbs,
    compilerOptions: result.compilerOptions,
  };
}

function walkProjectAdapter(input: WalkInput<TypescriptParsedProject>): WalkOutput {
  const walked = walkProgram({
    program: input.project.program,
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
    kind: r.kind,
    childHash: r.childHash,
  }));
  const dependencySites: ContractDependencySiteRecord[] = walked.dependencySites.map((r) => ({
    nodeRef: r.node,
    sourceFileRef: r.sourceFile,
    ownerHash: r.ownerHash,
    specifier: r.specifier,
    line: r.line,
    column: r.column,
  }));
  return {
    occurrences: walked.functions,
    callSites,
    dependencySites,
    parseErrors: walked.parseErrors,
  };
}

function resolveCallSitesAdapter(
  input: ResolveInput<TypescriptParsedProject>,
): ResolveOutput {
  // Translate the contract's CallSiteRecord back into the TS-internal
  // shape that resolveEdgesFromRecords consumes.
  const tsCallSites: TsCallSiteRecord[] = input.callSites.map((r) => ({
    node: r.nodeRef as ts.Node,
    sourceFile: r.sourceFileRef as ts.SourceFile,
    ownerHash: r.ownerHash,
    kind: r.kind,
    childHash: r.childHash,
  }));
  const result = resolveEdgesFromRecords({
    catalog: input.catalog,
    program: input.project.program,
    projectDirAbs: input.projectDirAbs,
    callSites: tsCallSites,
  });

  // Phase 4 (DEC-498): resolve dependency sites if any. Translate
  // back to the TS-specific shape (with real ts.Node handles) and
  // run module resolution.
  const dependenciesByOwner = input.dependencySites && input.dependencySites.length > 0
    ? resolveDependencies(
        input.dependencySites.map((r): TsDependencySiteRecord => ({
          node: r.nodeRef as ts.Node,
          sourceFile: r.sourceFileRef as ts.SourceFile,
          ownerHash: r.ownerHash,
          specifier: r.specifier,
          line: r.line,
          column: r.column,
        })),
        input.catalog,
        input.project.program,
        input.projectDirAbs,
      )
    : undefined;

  return {
    edgesByOwner: collectByOwner(result.catalog),
    dependenciesByOwner,
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
    readFile: (fileName: string, encoding?: string): string | undefined =>
      ts.sys.readFile(fileName, encoding),
    directoryExists: (directoryName: string): boolean =>
      ts.sys.directoryExists(directoryName),
    getCurrentDirectory: (): string => ts.sys.getCurrentDirectory(),
    getDirectories: (path: string): string[] => ts.sys.getDirectories(path),
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };
}

/**
 * Resolve a single import site to its target module-init bodyHash(es).
 * Returns the empty array if the module resolves outside the catalog
 * (e.g. external package, `.d.ts` declaration file) or fails to resolve
 * at all — both treated as unresolved by downstream attribution.
 */
function resolveSiteTargets(
  site: TsDependencySiteRecord,
  compilerOptions: ts.CompilerOptions,
  moduleResolutionHost: ts.ModuleResolutionHost,
  projectDirAbs: string,
  moduleInitByFilePath: ReadonlyMap<string, string>,
): readonly string[] {
  const resolution = ts.resolveModuleName(
    site.specifier,
    site.sourceFile.fileName,
    compilerOptions,
    moduleResolutionHost,
  );
  if (resolution.resolvedModule === undefined) return [];
  // Convert absolute resolved path → project-relative POSIX path
  const projectRel = relative(projectDirAbs, resolution.resolvedModule.resolvedFileName)
    .split(sep)
    .join('/');
  const targetHash = moduleInitByFilePath.get(projectRel);
  return targetHash === undefined ? [] : [targetHash];
}

/**
 * Resolve TS import sites to target module-init bodyHashes. Imports
 * resolving to a same-project source file map to that file's
 * module-init occurrence; imports resolving to an external package or
 * a `.d.ts` declaration file (outside the catalog) produce unresolved
 * `DependencyEdge` entries with `to: []` and the raw specifier carried
 * in `specifier` for downstream attribution.
 *
 * Phase 4 of opensip's substrate consolidation (DEC-498).
 */
function resolveDependencies(
  sites: readonly TsDependencySiteRecord[],
  catalog: Catalog,
  program: ts.Program,
  projectDirAbs: string,
): ReadonlyMap<string, readonly DependencyEdge[]> {
  const moduleInitByFilePath = buildModuleInitIndex(catalog);
  const compilerOptions = program.getCompilerOptions();
  const moduleResolutionHost = createModuleResolutionHost();

  const out = new Map<string, DependencyEdge[]>();
  for (const site of sites) {
    const to = resolveSiteTargets(
      site,
      compilerOptions,
      moduleResolutionHost,
      projectDirAbs,
      moduleInitByFilePath,
    );
    const edge: DependencyEdge = {
      to,
      line: site.line,
      column: site.column,
      specifier: site.specifier,
    };
    const existing = out.get(site.ownerHash);
    if (existing === undefined) {
      out.set(site.ownerHash, [edge]);
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
function collectByOwner(
  catalog: Catalog,
): ReadonlyMap<string, readonly CallEdge[]> {
  const out = new Map<string, readonly CallEdge[]>();
  for (const arr of Object.values(catalog.functions)) {
    if (!arr) continue;
    for (const o of arr) {
      if (o.calls.length === 0) continue;
      out.set(o.bodyHash, o.calls);
    }
  }
  return out;
}

export const typescriptGraphAdapter: GraphLanguageAdapter<TypescriptParsedProject> = {
  id: 'typescript',
  fileExtensions: ['.ts', '.tsx'],
  displayName: 'TypeScript',
  discoverFiles: discoverFilesAdapter,
  parseProject: (input: ParseInput): ParseOutput<TypescriptParsedProject> =>
    parseTypescriptProject(input),
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
export type { TypescriptParsedProject } from './parse.js';
export type { EdgeResolver, ResolverContext } from './edge-resolvers/types.js';
export type { InventoryVisitor, VisitorContext } from './inventory-visitors/types.js';
export { isTypescriptTestFile } from './test-file.js';
