/**
 * @fileoverview Catalog JSON renderer — emits the engine's per-run
 * `Catalog` + edge output as a `CatalogExport` document conformant to
 * the wire shape opensip's substrate ingestor (Phase 5) consumes.
 *
 * Renderer is a pure function: takes the catalog + indexes + a tenant /
 * repo / git-sha scope + run provenance, returns a JSON string. Streams
 * to a file at the orchestrate-CLI level (not stdout) because catalog
 * JSON for 100k-file repos exceeds practical stdout buffer sizes —
 * see Phase 3 Task 3.4 for the file-output wiring.
 *
 * Phase 3 Task 3.3 per DEC-498.
 *
 * Symbol-ID / edge-ID derivation: byte-for-byte mirror of opensip's
 * `computeSymbolId` / `computeEdgeId` so `INSERT ... ON CONFLICT DO
 * UPDATE` collides correctly on existing substrate rows.
 *
 * Edge taxonomy at v1: `calls` only. `depends_on` (module-import
 * edges) lands in Phase 4. `creation` may be added later.
 */

import {
  deriveOpenSipEdgeId,
  deriveOpenSipModulePath,
  deriveOpenSipSymbolId,
} from './opensip-id-derivation.js';

import type {
  CatalogExport,
  CatalogExportEdge,
  CatalogExportProvenance,
  CatalogExportSymbol,
} from './catalog-json-types.js';
import type {
  CallEdge,
  Catalog,
  FunctionKind,
  FunctionOccurrence,
  Indexes,
} from '../types.js';

/**
 * Map the engine's richer `FunctionKind` to opensip's
 * `code_symbols.kind` column convention. Surjective:
 *
 *   function-declaration → function
 *   function-expression  → function
 *   arrow                → function
 *   method               → method
 *   getter               → method
 *   setter               → method
 *   constructor          → constructor
 *   module-init          → module-init
 */
function mapKindToOpenSip(kind: FunctionKind): string {
  switch (kind) {
    case 'function-declaration':
    case 'function-expression':
    case 'arrow':
      return 'function';
    case 'method':
    case 'getter':
    case 'setter':
      return 'method';
    case 'constructor':
      return 'constructor';
    case 'module-init':
      return 'module-init';
  }
}

/**
 * Derive an opensip-compatible symbol-row payload for one engine
 * `FunctionOccurrence`.
 */
function occurrenceToSymbol(
  occurrence: FunctionOccurrence,
  repoId: string,
  language: string,
  gitSha: string,
): CatalogExportSymbol {
  const modulePath = deriveOpenSipModulePath(occurrence.filePath);
  const kind = mapKindToOpenSip(occurrence.kind);
  const arity = occurrence.params.length;

  const id = deriveOpenSipSymbolId({
    repoId,
    modulePath,
    kind,
    qualifiedName: occurrence.qualifiedName,
    arity,
  });

  return {
    id,
    repoId,
    kind,
    language,
    qualifiedName: occurrence.qualifiedName,
    modulePath,
    arity,
    filePath: occurrence.filePath,
    startLine: occurrence.line,
    endLine: occurrence.endLine,
    isExported: occurrence.visibility === 'exported',
    signature: occurrence.returnType !== null
      ? `(${occurrence.params.map((p) => p.name).join(', ')}): ${occurrence.returnType}`
      : null,
    docSummary: null,
    gitSha,
  };
}

/**
 * Map engine's `CallEdge` to one or more `CatalogExportEdge` rows.
 *
 * - Polymorphic edges (`to.length > 1`) split into one row per target.
 * - Unresolved edges (`to.length === 0`) emit a single row with
 *   `toSymbolId: null` and `toQualifiedNameUnresolved` set to the
 *   call-expression text (truncated to ≤ 80 chars per `CallEdge.text`).
 *   The text is informational for human inspection; the edge ID is
 *   hashed over (from, kind, "unresolved:" + text) so stability is
 *   preserved per (source, target-text).
 */
function callEdgeToRows(
  fromSymbolId: string,
  fromFilePath: string,
  callEdge: CallEdge,
  byBodyHash: ReadonlyMap<string, FunctionOccurrence>,
  repoId: string,
  gitSha: string,
): readonly CatalogExportEdge[] {
  const edgeKind = 'calls';

  if (callEdge.to.length === 0) {
    const id = deriveOpenSipEdgeId({
      fromSymbolId,
      edgeKind,
      toSymbolId: null,
      toQualifiedNameUnresolved: callEdge.text,
    });
    return [
      {
        id,
        repoId,
        edgeKind,
        fromSymbolId,
        toSymbolId: null,
        toQualifiedNameUnresolved: callEdge.text,
        sourceFile: fromFilePath,
        sourceLine: callEdge.line,
        gitSha,
      },
    ];
  }

  const rows: CatalogExportEdge[] = [];
  for (const toBodyHash of callEdge.to) {
    const target = byBodyHash.get(toBodyHash);
    if (target === undefined) {
      // Engine catalog invariant: every CallEdge.to bodyHash exists in
      // the catalog. A missing target is an engine bug; skip rather
      // than emit a half-formed row.
      continue;
    }
    const toSymbolId = deriveOpenSipSymbolId({
      repoId,
      modulePath: deriveOpenSipModulePath(target.filePath),
      kind: mapKindToOpenSip(target.kind),
      qualifiedName: target.qualifiedName,
      arity: target.params.length,
    });
    const id = deriveOpenSipEdgeId({
      fromSymbolId,
      edgeKind,
      toSymbolId,
      toQualifiedNameUnresolved: null,
    });
    rows.push({
      id,
      repoId,
      edgeKind,
      fromSymbolId,
      toSymbolId,
      toQualifiedNameUnresolved: null,
      sourceFile: fromFilePath,
      sourceLine: callEdge.line,
      gitSha,
    });
  }
  return rows;
}

export interface RenderCatalogJsonInput {
  readonly catalog: Catalog;
  readonly indexes: Indexes;
  readonly provenance: CatalogExportProvenance;
  readonly repoId: string;
  readonly gitSha: string;
}

/**
 * Render the engine's catalog as a `CatalogExport` JSON document.
 *
 * Ordering of `symbols` and `edges` is stable across runs (sorted by
 * id) so byte-equivalence holds for golden-fixture tests and
 * idempotent re-ingestion via `ON CONFLICT DO UPDATE`.
 */
export function renderCatalogJson(input: RenderCatalogJsonInput): string {
  const { catalog, indexes, provenance, repoId, gitSha } = input;
  const language = catalog.language;

  const symbols: CatalogExportSymbol[] = [];
  const edges: CatalogExportEdge[] = [];

  for (const occurrenceList of Object.values(catalog.functions)) {
    for (const occurrence of occurrenceList) {
      const symbol = occurrenceToSymbol(occurrence, repoId, language, gitSha);
      symbols.push(symbol);

      for (const callEdge of occurrence.calls) {
        const rows = callEdgeToRows(
          symbol.id,
          occurrence.filePath,
          callEdge,
          indexes.byBodyHash,
          repoId,
          gitSha,
        );
        edges.push(...rows);
      }
    }
  }

  // Stable ordering — deterministic output is the golden-fixture
  // contract. Sort by id (sha256 hex string, lexicographic).
  symbols.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));

  const doc: CatalogExport = {
    version: '1.0',
    provenance,
    symbols,
    edges,
  };

  return JSON.stringify(doc, null, 2);
}
