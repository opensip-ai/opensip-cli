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
 * `isTestFile`, but a call to the IMPORTED `@opensip-tools/fitness` `isTestFile`
 * still crosses the boundary). Conversely, a site the in-shard resolver already
 * resolved is skipped, so a recovered boundary edge never double-counts.
 */

import { relative, sep } from 'node:path';

import { ownerEdgeKey } from '@opensip-tools/graph';

import { isReturnValueDiscarded } from '../edges.js';

import { calleeSimpleName, buildImportSpecifierIndex } from './syntactic.js';

import type { CallSiteRecord } from '../walk.js';
import type { CallEdge, CrossBoundaryCall } from '@opensip-tools/graph';
import type ts from 'typescript';

/** Max length of the descriptor's display text — the CallEdge.text contract. */
const TEXT_MAX = 80;

/**
 * Extract cross-boundary call descriptors from a shard's walked call sites. A
 * site is a boundary candidate when its callee name is imported but the in-shard
 * resolver left it unresolved at this exact site — see the module doc for why
 * this is keyed on the resolution outcome (`resolvedEdgesByOwner`) rather than
 * on whether the callee name exists among the shard's occurrences.
 */
export function extractBoundaryCalls(
  callSites: readonly CallSiteRecord[],
  resolvedEdgesByOwner: ReadonlyMap<string, readonly CallEdge[]>,
  projectDirAbs: string,
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
    // Only imported names are cross-module candidates; skip globals/locals.
    if (importSpecifier === undefined) continue;

    let ownerFile = ownerFileBySf.get(r.sourceFile);
    if (ownerFile === undefined) {
      // Byte-identical to FunctionOccurrence.filePath (walk.ts) so the merge's
      // ownerEdgeKey(ownerHash, ownerFile) lookup hits and relative-import
      // pinning resolves against the owner's REAL directory.
      ownerFile = relative(projectDirAbs, r.sourceFile.fileName).split(sep).join('/');
      ownerFileBySf.set(r.sourceFile, ownerFile);
    }

    const pos = positionOf(r.node, r.sourceFile);
    // Skip a site the in-shard resolver already RESOLVED to a real target —
    // emitting a boundary call for it would double the edge. (A `to: []`
    // placeholder is NOT a resolution.) Keyed on the outcome at THIS site, so a
    // local same-name occurrence elsewhere in the shard no longer suppresses it.
    const resolvedHere = (
      resolvedEdgesByOwner.get(ownerEdgeKey(r.ownerHash, ownerFile)) ?? []
    ).some((e) => e.line === pos.line && e.column === pos.column && e.to.length > 0);
    if (resolvedHere) continue;

    out.push({
      ownerHash: r.ownerHash,
      ownerFile,
      calleeName: callee.name,
      importSpecifier,
      line: pos.line,
      column: pos.column,
      text: pos.text,
      discarded: isReturnValueDiscarded(r.node),
    });
  }
  return out;
}

/* `isReturnValueDiscarded` is imported from `../edges.js` so recovered
 * boundary edges carry the same `discarded` semantics as edges resolved
 * inline by the main Stage 2 pass. */

function positionOf(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): { readonly line: number; readonly column: number; readonly text: string } {
  const start = node.getStart(sourceFile);
  const lc = sourceFile.getLineAndCharacterOfPosition(start);
  const raw = sourceFile.text.slice(start, node.getEnd());
  return {
    line: lc.line + 1,
    column: lc.character,
    text: raw.length > TEXT_MAX ? `${raw.slice(0, TEXT_MAX - 3)}...` : raw,
  };
}
