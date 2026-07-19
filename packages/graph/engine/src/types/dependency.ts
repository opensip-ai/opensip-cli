/**
 * A resolved module-level dependency edge — an `import` / `from … import` /
 * `require` / `use` statement from one source file to another (or to an
 * external package the catalog doesn't track). Attached to module-init
 * occurrences only.
 *
 * Phase 4 of opensip's substrate consolidation (DEC-498) — preserves the
 * `depends_on` edge kind required by opensip's
 * `dependencyEdgesBetweenModules` query, which dispatch ticket grouping
 * and review-panel blast-radius depend on.
 *
 * `to.length === 0` means the import target is outside the catalog
 * (typically an external npm/PyPI/crates.io package). `specifier`
 * preserves the raw import string so unresolved edges remain traceable.
 */
/**
 * Bounded closed unions labelling a module-level dependency edge (P2 MCP audit
 * evidence, Phase 0). The three axes are orthogonal; valid form→role
 * combinations are constrained by {@link isValidDependencyFormRole}.
 */

/** How the dependency statement is written. */
export type DependencyForm =
  'import-declaration' | 'import-equals' | 're-export' | 'dynamic-import' | 'commonjs-require';

/** The executable role of the dependency. */
export type DependencyRole = 'runtime' | 'type-only' | 'mixed' | 'side-effect';

/** What kind of compiler target the specifier resolved to. */
export type DependencyTargetKind =
  'catalog-source' | 'declaration-file' | 'external' | 'unresolved';

/** How a `resolvedPackage` attribution was determined (or why there is none). */
export type DependencyResolutionBasis =
  'catalog-target' | 'workspace-manifest' | 'external-specifier' | 'unresolved';

/** The closed set of valid form→roles. A combination outside this map is an
 *  impossible/rejected classification a producer must never emit. */
const DEPENDENCY_FORM_ROLES: Readonly<Record<DependencyForm, readonly DependencyRole[]>> = {
  'import-declaration': ['runtime', 'type-only', 'mixed', 'side-effect'],
  'import-equals': ['runtime', 'type-only'],
  're-export': ['runtime', 'type-only', 'mixed'],
  'dynamic-import': ['runtime'],
  'commonjs-require': ['runtime'],
};

/** Is `role` a valid role for `form`? Producers validate before retaining a
 *  classification, and `CatalogRepo` re-validates after JSON decode. */
export function isValidDependencyFormRole(form: DependencyForm, role: DependencyRole): boolean {
  return DEPENDENCY_FORM_ROLES[form]?.includes(role) ?? false;
}

/**
 * Atomic classification of one {@link DependencyEdge}. All-or-nothing: the whole
 * object is absent on a pre-feature edge — a producer never emits it with one
 * subfield missing, and no consumer interprets a single missing subfield as
 * "unsupported". External/unresolved edges omit `resolvedPackage` but retain
 * form/role/targetKind/basis/reason.
 */
export interface DependencyClassification {
  readonly form: DependencyForm;
  readonly role: DependencyRole;
  readonly targetKind: DependencyTargetKind;
  readonly basis: DependencyResolutionBasis;
  /** Unique workspace package name when attributable; absent for external/unresolved. */
  readonly resolvedPackage?: string;
  /** Stable, bounded reason string for the target/resolution outcome. */
  readonly reason: string;
}

/**
 * One import/require/use edge from a module-init occurrence to resolved targets.
 * Carries the raw specifier plus optional atomic classification (form/role/basis).
 */
export interface DependencyEdge {
  /** bodyHash[] of the target module-init occurrence(s). Empty when the
   *  import resolves to a module outside the catalog (external package). */
  readonly to: readonly string[];
  /** 1-based line of the import / require / use statement. */
  readonly line: number;
  /** 0-based column. */
  readonly column: number;
  /** The raw import specifier — `'./foo'`, `'@opensip/core'`, `'os.path'`,
   *  `'std::collections'`, etc. Preserved for unresolved-edge attribution. */
  readonly specifier: string;
  /**
   * Atomic form/role/target/basis classification (P2 Phase 0). Absent on a
   * pre-feature catalog edge; present-and-complete on a current one. Never
   * interpret one missing subfield as unsupported — the whole object is the
   * unit of presence.
   */
  readonly classification?: DependencyClassification;
}
