// ── Semantic declaration / cross-file reference facts (P2 MCP audit Phase 3) ──
//
// Optional compiler-attested plane for non-callable declarations and cross-file
// references. Absence on Catalog/ResolveOutput = unsupported (pre-feature, fast
// mode, non-TS adapters). Present with empty arrays = supported, no facts.
// Catalog version stays `3.0`; identity/cap changes bump the independent
// semantic-fact cache ABI segment (`sem=` in stampEngineVersion).

/** Kind of a compiler-attested declaration fact. */
export type DeclarationKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type-alias'
  | 'enum'
  | 'namespace'
  | 'variable'
  | 'property'
  | 'method'
  | 'import'
  | 'export';

/** Kind of a cross-file reference site. */
export type ReferenceKind = 'type' | 'value' | 'import' | 'export' | 'heritage' | 'annotation';

/** How a reference's target was resolved (or why it was not). */
export type SemanticResolutionBasis =
  | 'compiler-declaration'
  | 'workspace-export-index'
  | 'import-specifier'
  | 'unresolved'
  | 'ambiguous'
  | 'external';

/** Confidence in a resolved/unresolved semantic reference. */
export type SemanticConfidence = 'high' | 'medium' | 'low';

/** Visibility of a declaration relative to its module/package. */
export type SemanticVisibility = 'exported' | 'module-local' | 'private';

/** Export role of a declaration (orthogonal to visibility for imports). */
export type SemanticExportRole = 'named-export' | 'default-export' | 're-export' | 'none';

/**
 * One compiler-attested declaration in project source. Stable identity is
 * {@link declarationId}; never a callable `FunctionOccurrence` id.
 * Signature-only declarations (interfaces, type aliases, …) remain here.
 */
export interface DeclarationFact {
  /** Stable id: `d1:` + code-point keys of package/path/kind/name/span. */
  readonly declarationId: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: DeclarationKind;
  /** Workspace package group (manifest name or path segment). */
  readonly package: string;
  /** Project-relative POSIX path. */
  readonly filePath: string;
  /** 1-based start line. */
  readonly line: number;
  /** 0-based start column. */
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly visibility: SemanticVisibility;
  readonly exportRole: SemanticExportRole;
  readonly inTestFile: boolean;
  readonly definedInGenerated: boolean;
}

/**
 * One cross-file reference site. Same-file and declaration-file sites are
 * intentionally omitted (`referenceScope: 'cross-file'` only).
 */
export interface CrossFileReferenceFact {
  /** Stable id: `r1:` + code-point keys of path/kind/span/target. */
  readonly referenceId: string;
  readonly kind: ReferenceKind;
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly package: string;
  /**
   * Resolved project declaration id when uniquely attributed. Absent for
   * unresolved/external/ambiguous; never a dangling id after cap selection.
   */
  readonly targetDeclarationId?: string;
  readonly targetPackage?: string;
  readonly targetName?: string;
  readonly targetKind?: DeclarationKind;
  readonly basis: SemanticResolutionBasis;
  readonly confidence: SemanticConfidence;
  /** Import specifier when the reference is import/export-mediated. */
  readonly importSpecifier?: string;
  /** Stable reason for unresolved/ambiguous/cap-downgrade outcomes. */
  readonly reason?: string;
  readonly inTestFile: boolean;
  readonly definedInGenerated: boolean;
}

/**
 * Producer coverage for a {@link SemanticFactBundle}. Independent of graph/read
 * coverage facets — this describes capture completeness at emit time.
 */
export interface SemanticFactProducerCoverage {
  readonly status: 'complete' | 'partial';
  readonly inspectedDeclarations: number;
  readonly emittedDeclarations: number;
  readonly omittedDeclarations: number;
  readonly inspectedReferences: number;
  readonly emittedReferences: number;
  readonly omittedReferences: number;
  /** Sorted, stable reason codes (e.g. `declaration-cap`, `path-outside-root`). */
  readonly reasons: readonly string[];
}

/**
 * Bounded optional semantic plane on a catalog / resolve result.
 * `referenceScope` is always `'cross-file'` — the only scope this plane covers.
 */
export interface SemanticFactBundle {
  readonly referenceScope: 'cross-file';
  readonly declarations: readonly DeclarationFact[];
  readonly references: readonly CrossFileReferenceFact[];
  readonly coverage: SemanticFactProducerCoverage;
}

/** Max retained declaration facts per catalog generation. */
export const MAX_SEMANTIC_DECLARATIONS = 100_000;
/** Max retained cross-file reference facts per catalog generation. */
export const MAX_SEMANTIC_REFERENCES = 500_000;
/** Max retained references pointing at one declaration (producer soft bound). */
export const MAX_REFERENCES_PER_DECLARATION = 1000;
/** Max characters for declaration/reference simple names. */
export const MAX_SEMANTIC_NAME = 256;
/** Max characters for qualified names, import specifiers, and paths. */
export const MAX_SEMANTIC_TEXT = 1024;
/** Max 1-based line accepted on a semantic fact span. */
export const MAX_SEMANTIC_LINE = 10_000_000;
/** Max 0-based column accepted on a semantic fact span. */
export const MAX_SEMANTIC_COLUMN = 1_000_000;

/** Immutable producer/repository bounds object for collectors and validators. */
export interface SemanticFactLimits {
  readonly maxDeclarations: number;
  readonly maxReferences: number;
  readonly maxReferencesPerDeclaration: number;
  readonly maxName: number;
  readonly maxText: number;
  readonly maxLine: number;
  readonly maxColumn: number;
}

/** Production limits — pure collectors accept an override for unit tests. */
export const DEFAULT_SEMANTIC_FACT_LIMITS: SemanticFactLimits = {
  maxDeclarations: MAX_SEMANTIC_DECLARATIONS,
  maxReferences: MAX_SEMANTIC_REFERENCES,
  maxReferencesPerDeclaration: MAX_REFERENCES_PER_DECLARATION,
  maxName: MAX_SEMANTIC_NAME,
  maxText: MAX_SEMANTIC_TEXT,
  maxLine: MAX_SEMANTIC_LINE,
  maxColumn: MAX_SEMANTIC_COLUMN,
};
