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
 * Edge taxonomy at v1: `calls` plus `depends_on` module-import edges.
 * `creation` may be added later.
 */

import { resolveCallee } from '../resolve-callee.js';

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
  DependencyEdge,
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
    case 'arrow': {
      return 'function';
    }
    case 'method':
    case 'getter':
    case 'setter': {
      return 'method';
    }
    case 'constructor': {
      return 'constructor';
    }
    case 'module-init': {
      return 'module-init';
    }
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
    signature: occurrence.returnType === null
      ? null
      : `(${occurrence.params.map((p) => p.name).join(', ')}): ${occurrence.returnType}`,
    docSummary: null,
    gitSha,
  };
}

/**
 * The repo + commit identity stamped onto every exported symbol/edge id.
 * Threaded as one value so the row mappers stay under the wide-function
 * parameter budget.
 */
interface ExportIdentity {
  readonly repoId: string;
  readonly gitSha: string;
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
  callerOcc: FunctionOccurrence,
  callEdge: CallEdge,
  indexes: Indexes,
  identity: ExportIdentity,
): readonly CatalogExportEdge[] {
  const { repoId, gitSha } = identity;
  const fromFilePath = callerOcc.filePath;
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
    const target = resolveCallee(toBodyHash, callerOcc, indexes);
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

/**
 * Map an engine `DependencyEdge` to one or more `CatalogExportEdge`
 * rows with `edgeKind: 'depends_on'`.
 *
 * - Polymorphic-target case (`to.length > 1`) is rare for imports but
 *   handled the same way as calls: one row per target.
 * - Unresolved target (`to.length === 0`) emits a single row with
 *   `toSymbolId: null` and the raw import specifier in
 *   `toQualifiedNameUnresolved` — preserves attribution for external
 *   packages that aren't in the catalog.
 *
 * Phase 4 of opensip's substrate consolidation (DEC-498).
 */
function dependencyEdgeToRows(
  fromSymbolId: string,
  fromFilePath: string,
  depEdge: DependencyEdge,
  byBodyHash: ReadonlyMap<string, FunctionOccurrence>,
  identity: ExportIdentity,
): readonly CatalogExportEdge[] {
  const { repoId, gitSha } = identity;
  const edgeKind = 'depends_on';

  if (depEdge.to.length === 0) {
    const id = deriveOpenSipEdgeId({
      fromSymbolId,
      edgeKind,
      toSymbolId: null,
      toQualifiedNameUnresolved: depEdge.specifier,
    });
    return [
      {
        id,
        repoId,
        edgeKind,
        fromSymbolId,
        toSymbolId: null,
        toQualifiedNameUnresolved: depEdge.specifier,
        sourceFile: fromFilePath,
        sourceLine: depEdge.line,
        gitSha,
      },
    ];
  }

  const rows: CatalogExportEdge[] = [];
  for (const toBodyHash of depEdge.to) {
    const target = byBodyHash.get(toBodyHash);
    if (target === undefined) {
      // Engine catalog invariant: every DependencyEdge.to bodyHash
      // exists in the catalog. A missing target is an engine/adapter
      // bug; skip rather than emit a half-formed row.
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
      sourceLine: depEdge.line,
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
  const identity: ExportIdentity = { repoId, gitSha };

  const symbols: CatalogExportSymbol[] = [];
  const edges: CatalogExportEdge[] = [];

  for (const occurrenceList of Object.values(catalog.functions)) {
    for (const occurrence of occurrenceList) {
      const symbol = occurrenceToSymbol(occurrence, repoId, language, gitSha);
      symbols.push(symbol);

      for (const callEdge of occurrence.calls) {
        const rows = callEdgeToRows(symbol.id, occurrence, callEdge, indexes, identity);
        edges.push(...rows);
      }

      // Phase 4 (DEC-498): module-level depends_on edges. Only
      // module-init occurrences carry these; for all other occurrences
      // the field is absent.
      if (occurrence.dependencies !== undefined) {
        for (const depEdge of occurrence.dependencies) {
          const rows = dependencyEdgeToRows(
            symbol.id,
            occurrence.filePath,
            depEdge,
            indexes.byBodyHash,
            identity,
          );
          edges.push(...rows);
        }
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
