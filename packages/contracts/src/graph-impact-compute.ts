/**
 * Pure changed→impact compute over the GraphCatalog contract (ADR-0085).
 *
 * Lives in contracts (layer 2) so both graph and fitness can import it without
 * a tool→tool edge.
 */
import { buildImpactTrust, mergeImpactUncertainties } from './impact-trust.js';

import type { GraphCatalog, GraphFunctionOccurrence } from './graph-catalog.js';
import type { ImpactTrust, ImpactUncertainty } from './impact-trust.js';

/** One function in the impact result — a changed function or an impacted caller. */
export interface ImpactFunction {
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly line: number;
  readonly package?: string;
  readonly blastScore?: number;
  readonly testReachable?: boolean;
  readonly reason: 'changed' | 'caller' | 'callee' | 'blast' | 'test-gap' | 'coupling';
}

/** A package touched by the impact set, with the count of its impacted functions. */
export interface ImpactPackage {
  readonly name: string;
  readonly functionCount: number;
}

/** The full result of {@link computeImpact}: changed + impacted functions, packages, and whether `--top` truncated. */
export interface ImpactComputation {
  readonly changedFunctions: readonly ImpactFunction[];
  readonly impactedFunctions: readonly ImpactFunction[];
  readonly impactedPackages: readonly ImpactPackage[];
  readonly impactedFiles: readonly string[];
  readonly trust: ImpactTrust;
  readonly truncated: boolean;
}

/** Changed-file entry metadata accepted by {@link computeImpact}. */
export interface ComputeImpactChangedFileEntry {
  readonly path: string;
  readonly status?:
    'added' | 'modified' | 'copied' | 'renamed' | 'deleted' | 'untracked' | 'unknown';
  readonly previousPath?: string;
}

/** Optional knobs and caller-known uncertainty facts for {@link computeImpact}. */
export interface ComputeImpactOptions {
  readonly maxDepth?: number;
  readonly top?: number;
  readonly changedFileEntries?: readonly ComputeImpactChangedFileEntry[];
  readonly uncertainties?: readonly ImpactUncertainty[];
}

const DEFAULT_MAX_DEPTH = 5;
const HIGH_BLAST_THRESHOLD = 10;

function derivePackage(occ: GraphFunctionOccurrence): string {
  if (occ.package) return occ.package;
  const segment = occ.filePath.split('/')[0];
  return segment ?? 'root';
}

function addReverseEdgesForOcc(reverse: Map<string, string[]>, occ: GraphFunctionOccurrence): void {
  // `CallEdge.to` entries are callee bodyHashes — the catalog is the id
  // authority (graph engine `types.ts`: "every CallEdge.to is a bodyHash that
  // already exists in the catalog"). Reverse each edge directly on bodyHashes:
  // every callee bodyHash maps to the caller bodyHashes that reach it. (An
  // earlier version looked `edge.to` up in a qualifiedName→bodyHash index,
  // which silently produced an empty reverse graph in production, where a
  // content hash never equals a dotted qualified name.)
  for (const edge of occ.calls) {
    for (const calleeHash of edge.to) {
      const callers = reverse.get(calleeHash) ?? [];
      callers.push(occ.bodyHash);
      reverse.set(calleeHash, callers);
    }
  }
}

function buildReverseAdjacency(catalog: GraphCatalog): Map<string, readonly string[]> {
  const reverse = new Map<string, string[]>();
  for (const occurrences of Object.values(catalog.functions)) {
    for (const occ of occurrences) {
      addReverseEdgesForOcc(reverse, occ);
    }
  }
  return reverse;
}

function allOccurrences(catalog: GraphCatalog): GraphFunctionOccurrence[] {
  const result: GraphFunctionOccurrence[] = [];
  for (const occurrences of Object.values(catalog.functions)) {
    result.push(...occurrences);
  }
  return result;
}

function toImpactFunction(
  occ: GraphFunctionOccurrence,
  reason: ImpactFunction['reason'],
  catalog: GraphCatalog,
): ImpactFunction {
  const features = catalog.features?.function?.[occ.bodyHash];
  return {
    qualifiedName: occ.qualifiedName,
    filePath: occ.filePath,
    line: occ.line,
    package: derivePackage(occ),
    blastScore: features?.blast?.score,
    testReachable: features?.testReachable,
    reason,
  };
}

function blastScore(catalog: GraphCatalog, bodyHash: string): number | undefined {
  return catalog.features?.function?.[bodyHash]?.blast?.score;
}

function isTestGap(catalog: GraphCatalog, bodyHash: string): boolean {
  const features = catalog.features?.function?.[bodyHash];
  return features?.reachableOnlyFromTests === true || features?.testReachable === false;
}

function impactReason(catalog: GraphCatalog, bodyHash: string): ImpactFunction['reason'] {
  const score = blastScore(catalog, bodyHash);
  if (score !== undefined && score >= HIGH_BLAST_THRESHOLD) return 'blast';
  if (isTestGap(catalog, bodyHash)) return 'test-gap';
  return 'caller';
}

interface CallerBfsContext {
  readonly reverse: Map<string, readonly string[]>;
  readonly changedBodyHashes: Set<string>;
  readonly visited: Set<string>;
  readonly queue: { readonly hash: string; readonly depth: number }[];
}

function enqueueUnvisitedCallers(ctx: CallerBfsContext, bodyHash: string, depth: number): void {
  for (const caller of ctx.reverse.get(bodyHash) ?? []) {
    if (ctx.changedBodyHashes.has(caller) || ctx.visited.has(caller)) continue;
    ctx.visited.add(caller);
    ctx.queue.push({ hash: caller, depth });
  }
}

function collectImpactedBodyHashes(
  reverse: Map<string, readonly string[]>,
  changedBodyHashes: Set<string>,
  maxDepth: number,
): string[] {
  const ctx: CallerBfsContext = {
    reverse,
    changedBodyHashes,
    visited: new Set<string>(),
    queue: [],
  };
  const impactedBodyHashes: string[] = [];

  for (const hash of changedBodyHashes) {
    enqueueUnvisitedCallers(ctx, hash, 1);
  }

  while (ctx.queue.length > 0) {
    const current = ctx.queue.shift()!;
    if (current.depth > maxDepth) continue;
    impactedBodyHashes.push(current.hash);
    enqueueUnvisitedCallers(ctx, current.hash, current.depth + 1);
  }

  return impactedBodyHashes;
}

function buildImpactedPackages(
  changedFunctions: readonly ImpactFunction[],
  impactedFunctions: readonly ImpactFunction[],
): ImpactPackage[] {
  const packageCounts = new Map<string, number>();
  for (const fn of [...changedFunctions, ...impactedFunctions]) {
    const pkg = fn.package ?? 'root';
    packageCounts.set(pkg, (packageCounts.get(pkg) ?? 0) + 1);
  }
  return [...packageCounts.entries()]
    .map(([name, functionCount]) => ({ name, functionCount }))
    .sort((a, b) => b.functionCount - a.functionCount);
}

function buildImpactedFiles(
  changedFunctions: readonly ImpactFunction[],
  impactedFunctions: readonly ImpactFunction[],
): string[] {
  const fileSet = new Set<string>();
  for (const fn of [...changedFunctions, ...impactedFunctions]) {
    fileSet.add(fn.filePath);
  }
  return [...fileSet].sort();
}

function applyTopCap(
  changedFunctions: readonly ImpactFunction[],
  impactedFunctions: readonly ImpactFunction[],
  topCap: number | undefined,
): { impactedFunctions: readonly ImpactFunction[]; truncated: boolean } {
  if (topCap === undefined || topCap < 0) {
    return { impactedFunctions, truncated: false };
  }
  const total = changedFunctions.length + impactedFunctions.length;
  if (total <= topCap) {
    return { impactedFunctions, truncated: false };
  }
  const remaining = Math.max(0, topCap - changedFunctions.length);
  return { impactedFunctions: impactedFunctions.slice(0, remaining), truncated: true };
}

function catalogFileSet(catalog: GraphCatalog): ReadonlySet<string> {
  const files = new Set<string>();
  for (const occ of allOccurrences(catalog)) {
    files.add(occ.filePath.replaceAll('\\', '/'));
  }
  return files;
}

function isCatalogApproximate(catalog: GraphCatalog): boolean {
  if (catalog.resolutionMode === 'fast') return true;
  for (const occurrences of Object.values(catalog.functions)) {
    for (const occ of occurrences) {
      if (occ.calls.some((edge) => edge.confidence !== 'high' || edge.resolution === 'syntactic')) {
        return true;
      }
    }
  }
  return false;
}

function catalogUncertainties(catalog: GraphCatalog): ImpactUncertainty[] {
  const uncertainties: ImpactUncertainty[] = [];
  if (!catalog.cacheKey || !catalog.filesFingerprint) {
    uncertainties.push({
      code: 'graph-catalog-incomplete',
      source: 'catalog',
      message: 'Graph catalog is missing cache freshness metadata.',
    });
  }
  if (isCatalogApproximate(catalog)) {
    uncertainties.push({
      code: 'graph-catalog-approximate',
      source: 'catalog',
      message: 'Graph catalog contains approximate call resolution.',
    });
  }
  return uncertainties;
}

function changedFileEntryUncertainties(
  catalog: GraphCatalog,
  changedFiles: readonly string[],
  entries: readonly ComputeImpactChangedFileEntry[] | undefined,
): ImpactUncertainty[] {
  const catalogFiles = catalogFileSet(catalog);
  const normalizedEntries: readonly ComputeImpactChangedFileEntry[] =
    entries === undefined || entries.length === 0
      ? changedFiles.map((path) => ({ path }))
      : entries;
  const uncertainties: ImpactUncertainty[] = [];
  for (const entry of normalizedEntries) {
    const normalizedPath = entry.path.replaceAll('\\', '/');
    if (entry.status === 'deleted') {
      uncertainties.push({
        code: 'changed-file-deleted',
        source: 'git',
        filePath: normalizedPath,
        message: `Changed file ${normalizedPath} was deleted; downstream imports may need a broader run.`,
      });
      continue;
    }
    if (entry.status === 'renamed') {
      uncertainties.push({
        code: 'changed-file-renamed',
        source: 'git',
        filePath: normalizedPath,
        message: `Changed file ${normalizedPath} was renamed; import edges may have shifted.`,
      });
    }
    if (!catalogFiles.has(normalizedPath)) {
      uncertainties.push({
        code: 'changed-file-unmatched',
        source: 'impact',
        filePath: normalizedPath,
        message: `Changed file ${normalizedPath} is not represented in the graph catalog.`,
      });
    }
  }
  return uncertainties;
}

/**
 * Compute changed functions and reverse-BFS impacted closure over a catalog.
 */
export function computeImpact(
  catalog: GraphCatalog,
  changedFiles: readonly string[],
  opts?: ComputeImpactOptions,
): ImpactComputation {
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const changedSet = new Set(changedFiles.map((f) => f.replaceAll('\\', '/')));

  const occurrences = allOccurrences(catalog);
  const bodyHashToOcc = new Map<string, GraphFunctionOccurrence>();
  for (const occ of occurrences) {
    bodyHashToOcc.set(occ.bodyHash, occ);
  }

  const changedOccs = occurrences.filter((occ) =>
    changedSet.has(occ.filePath.replaceAll('\\', '/')),
  );
  const changedBodyHashes = new Set(changedOccs.map((o) => o.bodyHash));
  const changedFunctions = changedOccs.map((occ) => toImpactFunction(occ, 'changed', catalog));

  const reverse = buildReverseAdjacency(catalog);
  const impactedBodyHashes = collectImpactedBodyHashes(reverse, changedBodyHashes, maxDepth);
  const impactedFunctions = impactedBodyHashes
    .map((hash) => bodyHashToOcc.get(hash))
    .filter((occ): occ is GraphFunctionOccurrence => occ !== undefined)
    .map((occ) => toImpactFunction(occ, impactReason(catalog, occ.bodyHash), catalog));

  const impactedPackages = buildImpactedPackages(changedFunctions, impactedFunctions);
  const { impactedFunctions: finalImpacted, truncated } = applyTopCap(
    changedFunctions,
    impactedFunctions,
    opts?.top,
  );
  const trust = buildImpactTrust({
    uncertainties: mergeImpactUncertainties(
      opts?.uncertainties,
      catalogUncertainties(catalog),
      changedFileEntryUncertainties(catalog, changedFiles, opts?.changedFileEntries),
      truncated
        ? [
            {
              code: 'impact-truncated',
              source: 'impact',
              message: 'Impact result was truncated by --top.',
            },
          ]
        : undefined,
    ),
  });

  return {
    changedFunctions,
    impactedFunctions: finalImpacted,
    impactedPackages,
    impactedFiles: buildImpactedFiles(changedFunctions, finalImpacted),
    trust,
    truncated,
  };
}
