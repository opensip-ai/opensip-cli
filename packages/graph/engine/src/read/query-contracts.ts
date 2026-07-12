function hasControlChar(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

/**
 * Feature-specific plain-data contracts for public graph audit reads
 * (MCP Graph Audit Readiness, Phase 0).
 *
 * These types are free-function inputs/outputs for `@opensip-cli/graph/read`.
 * Reuse Spec 20's {@link CatalogIdentity} from `./types.js` — do not redeclare it.
 */

import { pkgOf } from '../resolve-callee.js';

import type {
  CallConfidence,
  CallResolution,
  DependencyClassification,
  FunctionKind,
  FunctionOccurrence,
  Visibility,
} from '../types.js';

export type { AdapterSelectionEvidence, CatalogEngineMode } from '../types.js';

/** Production vs test vs all source files. */
export type SourceScope = 'production' | 'test' | 'all';

/** How generated-file occurrences are treated. */
export type GeneratedPolicy = 'exclude' | 'include' | 'only';

/** Traversal node identity mode. */
export type TraversalIdentity = 'occurrence' | 'body-twin-union';

/** Package dependency edge kind for package evidence queries. */
export type PackageEdgeKind = 'call' | 'import' | 'combined';

/** Freshness reason codes returned by complete input verification. */
export type FreshnessReasonCode =
  | 'missing'
  | 'files-changed'
  | 'language-changed'
  | 'cache-key-changed'
  | 'engine-mode-changed'
  | 'selection-changed'
  | 'verification-unavailable';

/** Bounded file-change summary (at most 50 samples). */
export interface FreshnessChangeSummary {
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
  readonly sample: readonly string[];
}

/**
 * Complete freshness verification result from {@link verifyCatalogInputs}.
 * `verification: 'partial'` never claims unqualified fresh.
 */
export interface FreshnessVerification {
  readonly fresh: boolean;
  readonly verifiedAt: string;
  readonly verification: 'complete' | 'partial' | 'missing';
  readonly reasonCode?: FreshnessReasonCode;
  readonly reason?: string;
  readonly changes?: FreshnessChangeSummary;
}

/**
 * Shared source filter applied before projection/paging in every graph read view.
 * Exact `filePath` and segment-aware `filePrefix` are both project-relative POSIX.
 */
export interface GraphSourceFilter {
  readonly packages?: readonly string[];
  /** Exact project-relative POSIX path. */
  readonly filePath?: string;
  /** Segment-aware prefix: matches path or path/…, not path-sibling. */
  readonly filePrefix?: string;
  readonly kinds?: readonly FunctionKind[];
  readonly visibilities?: readonly Visibility[];
  readonly sourceScope: SourceScope;
  readonly generated: GeneratedPolicy;
}

/** Effective filter echoed on every graph response (always fully populated). */
export type EffectiveGraphSourceFilter = GraphSourceFilter;

/** Coverage for a single read: complete vs hard-cap truncated. */
export interface GraphReadCoverage {
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly reasons: readonly string[];
}

/**
 * Public symbol projection reused by every graph audit view.
 * Control-free bounded fields; malformed oversized catalog rows are omitted.
 */
export interface GraphSymbolRef {
  /** Stable identity: `"${filePath}:${line}:${column}"`. */
  readonly symbolId: string;
  /** sha256(normalized body). */
  readonly bodyHash: string;
  readonly simpleName: string;
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly kind: FunctionKind;
  readonly visibility: Visibility;
  readonly package: string;
  readonly inTestFile: boolean;
  readonly definedInGenerated: boolean;
}

/** Resolved call-edge evidence (never includes call-expression text). */
export interface CallEdgeEvidence {
  readonly kind: 'call';
  readonly from: GraphSymbolRef;
  readonly to: GraphSymbolRef;
  readonly source: {
    readonly file: string;
    readonly line: number;
    readonly column: number;
  };
  readonly resolution: CallResolution;
  readonly confidence: CallConfidence;
  readonly crossShard: boolean;
}

/** Resolved call evidence crossing a canonical package boundary. */
export interface PackageCallEvidence extends CallEdgeEvidence {
  readonly fromPackage: string;
  readonly toPackage: string;
  readonly kind: 'call';
}

/** One module-level import statement and its package-resolution outcome. */
export interface PackageImportEvidence {
  readonly fromPackage: string;
  readonly toPackage: string | null;
  readonly target: string;
  readonly kind: 'import';
  readonly resolution: 'internal' | 'external' | 'unresolved';
  readonly specifier: string;
  readonly importSite: {
    readonly filePath: string;
    readonly line: number;
    readonly column: number;
  };
  /**
   * The persisted atomic dependency classification (form/role/target-kind/basis/
   * reason/resolvedPackage) of the underlying edge, when the producing catalog
   * carried one (P2 Phase 0.3). Absent for a pre-feature edge.
   */
  readonly classification?: DependencyClassification;
  /**
   * Attribution confidence (P2 Phase 0.3): `'high'` for a unique catalog-target
   * or a unique workspace-manifest declaration entry; absent for weaker /
   * unresolved / external outcomes.
   */
  readonly confidence?: 'high' | 'medium' | 'low';
}

/** Canonical concrete proof row for one package dependency. */
export type PackageDependencyEvidence = PackageCallEvidence | PackageImportEvidence;

/** Bounds for control-free projection fields. */
export const GRAPH_SYMBOL_PATH_MAX = 1024;
export const GRAPH_SYMBOL_NAME_MAX = 512;
export const GRAPH_SYMBOL_PACKAGE_MAX = 256;

const FUNCTION_KINDS: ReadonlySet<unknown> = new Set([
  'function-declaration',
  'function-expression',
  'arrow',
  'method',
  'constructor',
  'getter',
  'setter',
  'module-init',
]);
const VISIBILITIES: ReadonlySet<unknown> = new Set(['exported', 'module-local', 'private']);

function isSafeGraphProjectionText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= max && !hasControlChar(value)
  );
}

function isProjectRelativePosixPath(value: string): boolean {
  if (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.includes('\\') ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** Canonical graph package attribution, including the legacy `pkgOf` fallback. */
export function graphPackageOf(
  occurrence: Pick<FunctionOccurrence, 'package' | 'filePath'>,
): string {
  return pkgOf(occurrence);
}

/** Validate a package label before it crosses the public read boundary. */
export function toGraphPackageName(value: string): string | undefined {
  return isSafeGraphProjectionText(value, GRAPH_SYMBOL_PACKAGE_MAX) ? value : undefined;
}

/**
 * Project one occurrence to {@link GraphSymbolRef}.
 * Returns `undefined` when any identity field is malformed/oversized so the
 * caller can omit the row with partial coverage rather than truncate identity.
 */
export function toGraphSymbolRef(occurrence: FunctionOccurrence): GraphSymbolRef | undefined {
  if (
    !isSafeGraphProjectionText(occurrence.filePath, GRAPH_SYMBOL_PATH_MAX) ||
    !isProjectRelativePosixPath(occurrence.filePath) ||
    !isSafeGraphProjectionText(occurrence.simpleName, GRAPH_SYMBOL_NAME_MAX) ||
    !isSafeGraphProjectionText(occurrence.qualifiedName, GRAPH_SYMBOL_NAME_MAX) ||
    !isSafeGraphProjectionText(occurrence.bodyHash, GRAPH_SYMBOL_NAME_MAX)
  ) {
    return undefined;
  }
  const packageName = graphPackageOf(occurrence);
  if (
    !isSafeGraphProjectionText(packageName, GRAPH_SYMBOL_PACKAGE_MAX) ||
    !FUNCTION_KINDS.has(occurrence.kind) ||
    !VISIBILITIES.has(occurrence.visibility) ||
    typeof occurrence.inTestFile !== 'boolean' ||
    typeof occurrence.definedInGenerated !== 'boolean' ||
    !Number.isSafeInteger(occurrence.line) ||
    occurrence.line < 1 ||
    !Number.isSafeInteger(occurrence.column) ||
    occurrence.column < 0 ||
    !Number.isSafeInteger(occurrence.endLine) ||
    occurrence.endLine < occurrence.line
  ) {
    return undefined;
  }
  return {
    symbolId: `${occurrence.filePath}:${String(occurrence.line)}:${String(occurrence.column)}`,
    bodyHash: occurrence.bodyHash,
    simpleName: occurrence.simpleName,
    qualifiedName: occurrence.qualifiedName,
    filePath: occurrence.filePath,
    line: occurrence.line,
    column: occurrence.column,
    kind: occurrence.kind,
    visibility: occurrence.visibility,
    package: packageName,
    inTestFile: occurrence.inTestFile,
    definedInGenerated: occurrence.definedInGenerated,
  };
}
