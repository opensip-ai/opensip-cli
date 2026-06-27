/**
 * Pure changed→impact compute over the GraphCatalog contract (ADR-0085).
 *
 * Lives in contracts (layer 2) so both graph and fitness can import it without
 * a tool→tool edge.
 */
import type { GraphCatalog, GraphFunctionOccurrence } from './graph-catalog.js';

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
  readonly truncated: boolean;
}

const DEFAULT_MAX_DEPTH = 5;
const HIGH_BLAST_THRESHOLD = 10;

function derivePackage(occ: GraphFunctionOccurrence): string {
  if (occ.package) return occ.package;
  const segment = occ.filePath.split('/')[0];
  return segment ?? 'root';
}

function indexQualifiedToBodyHashes(catalog: GraphCatalog): Map<string, string[]> {
  const qualifiedToBodyHashes = new Map<string, string[]>();
  for (const occurrences of Object.values(catalog.functions)) {
    for (const occ of occurrences) {
      const existing = qualifiedToBodyHashes.get(occ.qualifiedName) ?? [];
      existing.push(occ.bodyHash);
      qualifiedToBodyHashes.set(occ.qualifiedName, existing);
    }
  }
  return qualifiedToBodyHashes;
}

function addReverseEdgesForOcc(
  reverse: Map<string, string[]>,
  occ: GraphFunctionOccurrence,
  qualifiedToBodyHashes: Map<string, string[]>,
): void {
  for (const edge of occ.calls) {
    for (const calleeQName of edge.to) {
      for (const calleeHash of qualifiedToBodyHashes.get(calleeQName) ?? []) {
        const callers = reverse.get(calleeHash) ?? [];
        callers.push(occ.bodyHash);
        reverse.set(calleeHash, callers);
      }
    }
  }
}

function buildReverseAdjacency(catalog: GraphCatalog): Map<string, readonly string[]> {
  const qualifiedToBodyHashes = indexQualifiedToBodyHashes(catalog);
  const reverse = new Map<string, string[]>();
  for (const occurrences of Object.values(catalog.functions)) {
    for (const occ of occurrences) {
      addReverseEdgesForOcc(reverse, occ, qualifiedToBodyHashes);
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

function enqueueUnvisitedCallers(
  reverse: Map<string, readonly string[]>,
  bodyHash: string,
  changedBodyHashes: Set<string>,
  visited: Set<string>,
  queue: { readonly hash: string; readonly depth: number }[],
  depth: number,
): void {
  for (const caller of reverse.get(bodyHash) ?? []) {
    if (changedBodyHashes.has(caller) || visited.has(caller)) continue;
    visited.add(caller);
    queue.push({ hash: caller, depth });
  }
}

function collectImpactedBodyHashes(
  reverse: Map<string, readonly string[]>,
  changedBodyHashes: Set<string>,
  maxDepth: number,
): string[] {
  const visited = new Set<string>();
  const impactedBodyHashes: string[] = [];
  const queue: { readonly hash: string; readonly depth: number }[] = [];

  for (const hash of changedBodyHashes) {
    enqueueUnvisitedCallers(reverse, hash, changedBodyHashes, visited, queue, 1);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > maxDepth) continue;
    impactedBodyHashes.push(current.hash);
    enqueueUnvisitedCallers(
      reverse,
      current.hash,
      changedBodyHashes,
      visited,
      queue,
      current.depth + 1,
    );
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

/**
 * Compute changed functions and reverse-BFS impacted closure over a catalog.
 */
export function computeImpact(
  catalog: GraphCatalog,
  changedFiles: readonly string[],
  opts?: { readonly maxDepth?: number; readonly top?: number },
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

  return {
    changedFunctions,
    impactedFunctions: finalImpacted,
    impactedPackages,
    truncated,
  };
}
