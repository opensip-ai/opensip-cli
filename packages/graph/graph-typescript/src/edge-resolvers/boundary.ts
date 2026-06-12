/**
 * Cross-shard boundary-call extraction (plan #2 — sharded build).
 *
 * When a shard worker resolves a shard's call sites, the calls that DON'T
 * land on one of the shard's own occurrences are candidate cross-package
 * edges — the target lives in another shard. This module identifies them
 * syntactically (callee name + the raw import specifier the name came
 * from) so the engine's cross-shard pass can re-resolve them against the
 * global merged catalog, where the target is present.
 *
 * Detection is by RESOLUTION OUTCOME, not by name: a site is a boundary
 * candidate when its callee name is IMPORTED (carries an import specifier) AND
 * the in-shard resolver did NOT resolve THIS call site to a target. Keying on
 * the per-site outcome (not "does the callee name exist among the shard's
 * occurrences?") is what fixes the name-collision class: a name imported from
 * another package is a cross-shard call even when a DIFFERENT local function in
 * this shard happens to share the name (e.g. checks-universal has a local
 * `isTestFile`, but a call to the IMPORTED `@opensip-cli/fitness` `isTestFile`
 * still crosses the boundary). Conversely, a site the in-shard resolver already
 * resolved is skipped, so a recovered boundary edge never double-counts.
 */

import { relative, sep } from 'node:path';

import { ownerEdgeKey } from '@opensip-cli/graph';
import ts from 'typescript';

import { isReturnValueDiscarded } from '../edges.js';

import { calleeAnchorNode, calleeSimpleName, buildImportSpecifierIndex } from './syntactic.js';

import type { CallSiteRecord } from '../walk.js';
import type { CallEdge, CrossBoundaryCall } from '@opensip-cli/graph';

/** Max length of the descriptor's display text — the CallEdge.text contract. */
const TEXT_MAX = 80;

/**
 * Resolve a method call's type-attested target SOURCE file (a cross-package
 * `recv.m()` whose `m` decl is in a workspace `dist/*.d.ts`), or null. Supplied
 * by the adapter (which owns the `ts.Program`/checker); absent in the fast tier.
 */
export type MethodTargetResolver = (node: ts.Node) => string | null;

/**
 * Extract cross-boundary call descriptors from a shard's walked call sites. A
 * site is a boundary candidate when the in-shard resolver left it unresolved AND
 * either (a) its callee name is IMPORTED (a cross-package FUNCTION), or (b) it is
 * a METHOD call `recv.m()` whose callee the checker resolves to a workspace
 * `dist/*.d.ts` (`resolveMethodTarget` attests the target file — a cross-package
 * METHOD). Both route through the same post-merge linker. Keyed on the resolution
 * outcome (`resolvedEdgesByOwner`) — see the module doc.
 */
export function extractBoundaryCalls(
  callSites: readonly CallSiteRecord[],
  resolvedEdgesByOwner: ReadonlyMap<string, readonly CallEdge[]>,
  projectDirAbs: string,
  resolveMethodTarget?: MethodTargetResolver,
): CrossBoundaryCall[] {
  const out: CrossBoundaryCall[] = [];
  // One import-specifier index per source file, built lazily and cached.
  const specifierIndexBySf = new Map<ts.SourceFile, ReadonlyMap<string, string>>();
  // Owner-file derivation is per source file; cache it so each boundary call on
  // the same file doesn't re-run the relative/posix math.
  const ownerFileBySf = new Map<ts.SourceFile, string>();

  for (const r of callSites) {
    if (r.kind !== 'call') continue; // 'creation' edges are always intra-shard
    const callee = calleeSimpleName(r.node);
    if (callee === null) continue;

    let specifierIndex = specifierIndexBySf.get(r.sourceFile);
    if (specifierIndex === undefined) {
      specifierIndex = buildImportSpecifierIndex(r.sourceFile);
      specifierIndexBySf.set(r.sourceFile, specifierIndex);
    }
    const importSpecifier = specifierIndex.get(callee.name);
    const methodEligible =
      resolveMethodTarget !== undefined &&
      ts.isCallExpression(r.node) &&
      ts.isPropertyAccessExpression(r.node.expression);
    // Candidate iff IMPORTED (function) or a METHOD call we can type-resolve.
    // Everything else (globals/locals/intra) is skipped before the position math.
    if (importSpecifier === undefined && !methodEligible) continue;

    let ownerFile = ownerFileBySf.get(r.sourceFile);
    if (ownerFile === undefined) {
      // Byte-identical to FunctionOccurrence.filePath (walk.ts) so the merge's
      // ownerEdgeKey(ownerHash, ownerFile) lookup hits and relative-import
      // pinning resolves against the owner's REAL directory.
      ownerFile = relative(projectDirAbs, r.sourceFile.fileName).split(sep).join('/');
      ownerFileBySf.set(r.sourceFile, ownerFile);
    }

    const bc = boundaryCallFor(r, callee.name, importSpecifier, ownerFile, {
      resolvedEdgesByOwner,
      resolveMethodTarget,
    });
    if (bc !== null) out.push(bc);
  }
  return out;
}

interface BoundaryDeps {
  readonly resolvedEdgesByOwner: ReadonlyMap<string, readonly CallEdge[]>;
  readonly resolveMethodTarget?: MethodTargetResolver;
}

/**
 * Finish classifying a candidate call site — its callee name, import specifier,
 * and owner file already resolved by the caller — into a boundary descriptor, or
 * `null` when the in-shard pass already resolved the site or it is not a
 * cross-package method. Extracted from the loop to keep each piece simple.
 */
function boundaryCallFor(
  r: CallSiteRecord,
  calleeName: string,
  importSpecifier: string | undefined,
  ownerFile: string,
  deps: BoundaryDeps,
): CrossBoundaryCall | null {
  const pos = positionOf(r.node, r.sourceFile);
  // Skip a site the in-shard resolver already RESOLVED to a real target —
  // emitting a boundary call for it would double the edge. (A `to: []`
  // placeholder is NOT a resolution.) Keyed on the outcome at THIS site, so a
  // local same-name occurrence elsewhere in the shard no longer suppresses it.
  const resolvedHere = (
    deps.resolvedEdgesByOwner.get(ownerEdgeKey(r.ownerHash, ownerFile)) ?? []
  ).some((e) => e.line === pos.line && e.column === pos.column && e.to.length > 0);
  if (resolvedHere) return null;

  // For a non-imported (method) candidate, attest the target only NOW (after the
  // cheap resolvedHere gate) to bound the checker calls. A method whose callee
  // resolves to SOURCE / node_modules / a non-dist `.d.ts` declines.
  const targetFile =
    importSpecifier === undefined ? (deps.resolveMethodTarget?.(r.node) ?? undefined) : undefined;
  if (importSpecifier === undefined && targetFile === undefined) return null;

  return {
    ownerHash: r.ownerHash,
    ownerFile,
    calleeName,
    ...(importSpecifier === undefined ? {} : { importSpecifier }),
    ...(targetFile === undefined ? {} : { targetFile }),
    line: pos.line,
    column: pos.column,
    text: pos.text,
    discarded: isReturnValueDiscarded(r.node),
  };
}

/* `isReturnValueDiscarded` is imported from `../edges.js` so recovered
 * boundary edges carry the same `discarded` semantics as edges resolved
 * inline by the main Stage 2 pass. */

function positionOf(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): { readonly line: number; readonly column: number; readonly text: string } {
  // Anchor at the CALLEE token (see edges.ts tsPosition + syntactic.calleeAnchorNode)
  // so the cross-shard edge identity matches the in-shard pass for the SAME call
  // and chained calls don't collide. TEXT stays the whole expression.
  const anchor = calleeAnchorNode(node).getStart(sourceFile);
  const lc = sourceFile.getLineAndCharacterOfPosition(anchor);
  const raw = sourceFile.text.slice(node.getStart(sourceFile), node.getEnd());
  return {
    line: lc.line + 1,
    column: lc.character,
    text: raw.length > TEXT_MAX ? `${raw.slice(0, TEXT_MAX - 3)}...` : raw,
  };
}
