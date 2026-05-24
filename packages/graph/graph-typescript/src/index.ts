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
 * one delegates to the existing legacy implementation and translates
 * I/O shapes:
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


import { cacheKey as typescriptCacheKey } from './cache-key.js';
import { discoverFiles as legacyDiscoverFiles } from './discover.js';
import { resolveEdgesFromRecords } from './edges.js';
import { parseProject as parseTypescriptProject } from './parse.js';
import { isTypescriptTestFile } from './test-file.js';
import { walkProgram } from './walk.js';

import type { TypescriptParsedProject } from './parse.js';
import type { CallSiteRecord as TsCallSiteRecord } from './walk.js';
import type {
  CallSiteRecord as ContractCallSiteRecord,
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
import type ts from 'typescript';


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
  const result = legacyDiscoverFiles({
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
  // Translate legacy CallSiteRecord (node/sourceFile) into the
  // contract's opaque shape (nodeRef/sourceFileRef). No data loss —
  // the same handles flow back into resolveCallSites unchanged.
  const callSites: ContractCallSiteRecord[] = walked.callSites.map((r) => ({
    nodeRef: r.node,
    sourceFileRef: r.sourceFile,
    ownerHash: r.ownerHash,
    kind: r.kind,
    childHash: r.childHash,
  }));
  return {
    occurrences: walked.functions,
    callSites,
    parseErrors: walked.parseErrors,
  };
}

function resolveCallSitesAdapter(
  input: ResolveInput<TypescriptParsedProject>,
): ResolveOutput {
  // Translate the contract's CallSiteRecord back into the legacy shape
  // that resolveEdgesFromRecords consumes.
  const legacyCallSites: TsCallSiteRecord[] = input.callSites.map((r) => ({
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
    callSites: legacyCallSites,
  });
  return {
    edgesByOwner: collectByOwner(result.catalog),
    stats: result.resolutionStats,
  };
}

/**
 * Build the `bodyHash → CallEdge[]` map the contract returns. The
 * legacy resolver wrote the edges directly into a freshly rebuilt
 * catalog; the contract surface separates resolution from catalog
 * mutation, so the orchestrator can stitch the edges into whatever
 * catalog shape it owns.
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
 * the CLI for diagnostics). The CLI bootstrap calls `registerAdapter`
 * with `adapter` after a successful `import()`.
 */
export const adapter = typescriptGraphAdapter;
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

// Lower-level helpers that engine integration tests (in
// @opensip-tools/graph) consume to drive a real TS pipeline against a
// temporary fixture without needing to wire the full orchestrator.
// Exposed for cross-package tests; not intended as a stable third-party
// adapter authoring API.
export { discoverFiles } from './discover.js';
export { buildInventory } from './inventory.js';
export { resolveEdges } from './edges.js';
