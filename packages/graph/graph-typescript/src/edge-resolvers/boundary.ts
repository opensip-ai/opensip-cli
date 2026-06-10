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
 * Detection is purely syntactic and mode-independent: "did this resolve
 * within the shard?" is just "is the callee name among the shard's own
 * occurrences?". We only emit a boundary call when the name was
 * IMPORTED — an imported name absent from this shard is, by construction,
 * defined in another module; a non-imported absent name is a global
 * (`console`, `Promise`) or an unresolved local, neither of which is a
 * cross-shard edge.
 */


import { relative, sep } from 'node:path';

import { isReturnValueDiscarded } from '../edges.js';

import { calleeSimpleName, buildImportSpecifierIndex } from './syntactic.js';

import type { CallSiteRecord } from '../walk.js';
import type { Catalog, CrossBoundaryCall } from '@opensip-tools/graph';
import type ts from 'typescript';

/** Max length of the descriptor's display text — the CallEdge.text contract. */
const TEXT_MAX = 80;

/**
 * Extract cross-boundary call descriptors from a shard's walked call
 * sites. A site is a boundary candidate when its callee name is imported
 * (carries an import specifier) but is not among the shard catalog's own
 * occurrences.
 */
export function extractBoundaryCalls(
  callSites: readonly CallSiteRecord[],
  catalog: Catalog,
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
    // Resolved within this shard's own occurrences → not a boundary call.
    const own = catalog.functions[callee.name];
    if (own && own.length > 0) continue;

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
