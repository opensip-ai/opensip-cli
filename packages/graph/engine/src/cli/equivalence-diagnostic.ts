/**
 * Equivalence-divergence diagnostic builder (pure).
 *
 * When `graph-equivalence-check` reports production decline/phantom divergences,
 * this turns each divergence into a fully-described record — owner occurrence,
 * resolved target occurrences, and the actual call edge on BOTH engines (plus the
 * same-call-site edge whatever its resolution) — so a maintainer can see exactly
 * how exact and sharded disagreed at a call site, not just the bodyHash deltas.
 *
 * It is the structured form of the throwaway instrumentation that originally
 * root-caused the 118-decline asymmetry (exact resolves workspace deps via
 * symlinked `packages/X/dist`, sharded via pnpm's injected `.pnpm/...@file+...`).
 * Keeping it as a maintained, env-gated artifact makes the NEXT equivalence
 * regression debuggable in minutes instead of hours.
 *
 * This module is PURE — no `fs`, no `process`, no `Date`. The host command
 * (`equivalence-check-command.ts`) owns the env gate + file/stdout effects, so
 * the analysis is unit-testable in isolation.
 */

import type { Catalog, CallEdge, FunctionOccurrence } from '../types.js';
import type { EdgeDifference } from './orchestrate/cross-shard-resolve.js';

/** Compact occurrence projection for the diagnostic JSON. */
export interface OccurrenceSummary {
  readonly simpleName: string;
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly kind: FunctionOccurrence['kind'];
  readonly visibility: FunctionOccurrence['visibility'];
  readonly package: string | undefined;
}

/** Compact call-edge projection for the diagnostic JSON. */
export interface EdgeSummary {
  readonly to: readonly string[];
  readonly line: number;
  readonly column: number;
  readonly resolution: CallEdge['resolution'];
  readonly confidence: CallEdge['confidence'];
  readonly text: string;
  readonly crossShard: boolean;
  readonly discarded: boolean;
}

/** One resolved target bodyHash and every occurrence that shares it. */
export interface TargetSummary {
  readonly hash: string;
  readonly occurrences: readonly OccurrenceSummary[];
}

/** A single divergence, described symmetrically across both engines. */
export interface DiffDiagnostic {
  readonly owner: {
    readonly hash: string;
    readonly filePath: string;
    readonly line: number;
    readonly column: number;
    readonly exact: OccurrenceSummary | null;
    readonly sharded: OccurrenceSummary | null;
  };
  readonly exactTo: readonly TargetSummary[];
  readonly shardedTo: readonly TargetSummary[];
  /** The edge whose target set exactly matches this divergence's recorded `to`. */
  readonly exactEdge: EdgeSummary | null;
  readonly shardedEdge: EdgeSummary | null;
  /** The edge at the same call site regardless of its resolved target set. */
  readonly exactSameSite: EdgeSummary | null;
  readonly shardedSameSite: EdgeSummary | null;
}

export interface EquivalenceDiagnostic {
  readonly counts: {
    readonly productionDecline: number;
    readonly productionPhantom: number;
  };
  readonly shards: readonly {
    readonly id: string;
    readonly rootDir: string;
    readonly fileCount: number;
  }[];
  /** Histogram: `<resolution>:<crossShard>` of the exact edge for each decline. */
  readonly declineByExactResolution: Record<string, number>;
  /** Histogram: `<resolution>:<crossShard>` of the sharded edge for each phantom. */
  readonly phantomByShardedResolution: Record<string, number>;
  readonly decline: readonly DiffDiagnostic[];
  readonly phantom: readonly DiffDiagnostic[];
}

export interface BuildEquivalenceDiagnosticInput {
  readonly report: {
    readonly productionDecline: readonly EdgeDifference[];
    readonly productionPhantom: readonly EdgeDifference[];
  };
  readonly exact: Catalog;
  readonly sharded: Catalog;
  readonly shards: readonly {
    readonly id: string;
    readonly rootDir: string;
    readonly files: readonly string[];
  }[];
}

/** Build the structured equivalence diagnostic. Pure: no I/O, no clock. */
export function buildEquivalenceDiagnostic(
  input: BuildEquivalenceDiagnosticInput,
): EquivalenceDiagnostic {
  const exactTargets = indexOccurrencesByHash(input.exact);
  const shardedTargets = indexOccurrencesByHash(input.sharded);
  const describe = (d: EdgeDifference): DiffDiagnostic =>
    describeDifference(d, input.exact, input.sharded, exactTargets, shardedTargets);
  const decline = input.report.productionDecline.map(describe);
  const phantom = input.report.productionPhantom.map(describe);
  return {
    counts: {
      productionDecline: decline.length,
      productionPhantom: phantom.length,
    },
    shards: input.shards.map((s) => ({
      id: s.id,
      rootDir: s.rootDir,
      fileCount: s.files.length,
    })),
    declineByExactResolution: countBy(decline, (d) => edgeResolutionKey(d.exactEdge)),
    phantomByShardedResolution: countBy(phantom, (d) => edgeResolutionKey(d.shardedEdge)),
    decline,
    phantom,
  };
}

function edgeResolutionKey(edge: EdgeSummary | null): string {
  return `${edge?.resolution ?? 'missing'}:${String(edge?.crossShard ?? false)}`;
}

function countBy<T>(items: readonly T[], keyOf: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const key = keyOf(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function describeDifference(
  diff: EdgeDifference,
  exact: Catalog,
  sharded: Catalog,
  exactTargets: ReadonlyMap<string, readonly FunctionOccurrence[]>,
  shardedTargets: ReadonlyMap<string, readonly FunctionOccurrence[]>,
): DiffDiagnostic {
  const atSign = diff.key.indexOf('@');
  const ownerHash = atSign === -1 ? diff.key : diff.key.slice(0, atSign);
  const exactOwner = findOccurrence(exact, ownerHash, diff.ownerFilePath);
  const shardedOwner = findOccurrence(sharded, ownerHash, diff.ownerFilePath);
  return {
    owner: {
      hash: ownerHash,
      filePath: diff.ownerFilePath,
      line: diff.line,
      column: diff.column,
      exact: exactOwner === undefined ? null : summarizeOccurrence(exactOwner),
      sharded: shardedOwner === undefined ? null : summarizeOccurrence(shardedOwner),
    },
    exactTo: splitTargets(diff.toA).map((hash) => summarizeTargets(hash, exactTargets)),
    shardedTo: splitTargets(diff.toB).map((hash) => summarizeTargets(hash, shardedTargets)),
    exactEdge: nullableEdge(findEdge(exactOwner, diff.line, diff.column, diff.toA)),
    shardedEdge: nullableEdge(findEdge(shardedOwner, diff.line, diff.column, diff.toB)),
    exactSameSite: nullableEdge(findAnyEdge(exactOwner, diff.line, diff.column)),
    shardedSameSite: nullableEdge(findAnyEdge(shardedOwner, diff.line, diff.column)),
  };
}

function nullableEdge(edge: CallEdge | undefined): EdgeSummary | null {
  return edge === undefined ? null : summarizeEdge(edge);
}

function indexOccurrencesByHash(
  catalog: Catalog,
): ReadonlyMap<string, readonly FunctionOccurrence[]> {
  const out = new Map<string, FunctionOccurrence[]>();
  for (const occs of Object.values(catalog.functions)) {
    for (const occ of occs ?? []) {
      const bucket = out.get(occ.bodyHash);
      if (bucket) bucket.push(occ);
      else out.set(occ.bodyHash, [occ]);
    }
  }
  return out;
}

function findOccurrence(
  catalog: Catalog,
  bodyHash: string,
  filePath: string,
): FunctionOccurrence | undefined {
  for (const occs of Object.values(catalog.functions)) {
    for (const occ of occs ?? []) {
      if (occ.bodyHash === bodyHash && occ.filePath === filePath) return occ;
    }
  }
  return undefined;
}

function findEdge(
  occ: FunctionOccurrence | undefined,
  line: number,
  column: number,
  toJoined: string,
): CallEdge | undefined {
  if (occ === undefined) return undefined;
  for (const edge of occ.calls) {
    if (edge.line !== line || edge.column !== column) continue;
    if ([...edge.to].sort().join(',') === toJoined) return edge;
  }
  return undefined;
}

function findAnyEdge(
  occ: FunctionOccurrence | undefined,
  line: number,
  column: number,
): CallEdge | undefined {
  return occ?.calls.find((edge) => edge.line === line && edge.column === column);
}

function splitTargets(toJoined: string): readonly string[] {
  return toJoined.length === 0 ? [] : toJoined.split(',');
}

function summarizeTargets(
  hash: string,
  targets: ReadonlyMap<string, readonly FunctionOccurrence[]>,
): TargetSummary {
  return {
    hash,
    occurrences: (targets.get(hash) ?? []).map(summarizeOccurrence),
  };
}

function summarizeOccurrence(occ: FunctionOccurrence): OccurrenceSummary {
  return {
    simpleName: occ.simpleName,
    qualifiedName: occ.qualifiedName,
    filePath: occ.filePath,
    line: occ.line,
    column: occ.column,
    kind: occ.kind,
    visibility: occ.visibility,
    package: occ.package,
  };
}

function summarizeEdge(edge: CallEdge): EdgeSummary {
  return {
    to: edge.to,
    line: edge.line,
    column: edge.column,
    resolution: edge.resolution,
    confidence: edge.confidence,
    text: edge.text,
    crossShard: edge.crossShard ?? false,
    discarded: edge.discarded ?? false,
  };
}
