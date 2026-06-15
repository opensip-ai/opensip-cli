/**
 * @fileoverview Engine-side mirror of opensip's content-derived
 * symbol-ID / edge-ID hashing. Byte-for-byte equivalent to
 * `computeSymbolId` / `computeEdgeId` in
 * `packages/code-graph/src/symbol-id.ts` so engine-emitted catalog
 * rows collide with existing substrate rows under `ON CONFLICT DO
 * UPDATE` (idempotent re-ingestion).
 *
 * Algorithm is intentionally trivial: canonicalize input fields into a
 * `::`-separated string and sha256. Determinism (rename-invariant
 * stability) is the load-bearing property — the ID changes when the
 * symbol identity changes (rename, module move, arity change) but not
 * when the file is renamed or lines shift.
 *
 * Cross-repo source-of-truth risk: if opensip's algorithm changes,
 * this mirror desynchronizes silently. The local golden tests pin this
 * package's implementation; a cross-repo parity test should compare it
 * against opensip's `computeSymbolId` / `computeEdgeId` whenever that
 * source is available. The engine-package version (carried in
 * `CatalogExportProvenance.engineVersion`) documents the cutover boundary
 * if the algorithm ever evolves.
 *
 * Phase 3 Task 3.2 per DEC-498.
 */

import { createHash } from 'node:crypto';

/**
 * Input to opensip's symbol-ID hash. Mirrors `SymbolIdInput` in
 * `packages/code-graph/src/symbol-id.ts`.
 */
export interface OpenSipSymbolIdInput {
  readonly repoId: string;
  readonly modulePath: string;
  readonly kind: string;
  readonly qualifiedName: string;
  readonly arity: number | null;
}

/**
 * Input to opensip's edge-ID hash. Mirrors `EdgeIdInput` in
 * `packages/code-graph/src/symbol-id.ts`.
 */
export interface OpenSipEdgeIdInput {
  readonly fromSymbolId: string;
  readonly edgeKind: string;
  readonly toSymbolId: string | null;
  readonly toQualifiedNameUnresolved: string | null;
}

/**
 * Derive opensip's symbol ID for a function / class / method / module.
 *
 * Mirrors `computeSymbolId(...)` byte-for-byte.
 */
export function deriveOpenSipSymbolId(input: OpenSipSymbolIdInput): string {
  const key = `${input.repoId}::${input.modulePath}::${input.kind}::${input.qualifiedName}::${input.arity ?? ''}`;
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Derive opensip's edge ID. Unresolved targets are canonicalized as
 * `unresolved:<qname>` so two distinct unresolved calls don't collide
 * on the same fromSymbolId + edgeKind.
 *
 * Mirrors `computeEdgeId(...)` byte-for-byte — including the subtle
 * empty-string fallback when both `toSymbolId` and
 * `toQualifiedNameUnresolved` are `null` (the key becomes
 * `<fromSymbolId>::<edgeKind>::unresolved:`).
 */
export function deriveOpenSipEdgeId(input: OpenSipEdgeIdInput): string {
  const target = input.toSymbolId ?? `unresolved:${input.toQualifiedNameUnresolved ?? ''}`;
  const key = `${input.fromSymbolId}::${input.edgeKind}::${target}`;
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Project a repo-relative file path to the canonical module path the
 * opensip indexer stores in `code_symbols.module_path`. Mirrors
 * `filePathToModulePath(...)` in
 * `packages/code-graph/src/module-path.ts`.
 *
 * Rule: strip the extension if the last `.` lives in the basename;
 * normalize Windows backslashes to POSIX `/`.
 */
export function deriveOpenSipModulePath(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const noExt = lastDot > lastSep ? filePath.slice(0, lastDot) : filePath;
  return noExt.replaceAll('\\', '/');
}
