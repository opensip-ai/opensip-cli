function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.codePointAt(i) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Feature-specific plain-data contracts for public graph audit reads
 * (MCP Graph Audit Readiness, Phase 0).
 *
 * These types are free-function inputs/outputs for `@opensip-cli/graph/read`.
 * Reuse Spec 20's {@link CatalogIdentity} from `./types.js` — do not redeclare it.
 */

import type {
  CallConfidence,
  CallResolution,
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
  readonly from: GraphSymbolRef;
  readonly to: GraphSymbolRef;
  readonly callSite: {
    readonly filePath: string;
    readonly line: number;
    readonly column: number;
  };
  readonly resolution: CallResolution;
  readonly confidence: CallConfidence;
  readonly crossShard: boolean;
}

/** Bounds for control-free projection fields. */
export const GRAPH_SYMBOL_PATH_MAX = 1024;
export const GRAPH_SYMBOL_NAME_MAX = 512;
export const GRAPH_SYMBOL_PACKAGE_MAX = 256;

function isControlFreeBounded(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && !hasControlChar(value);
}

/**
 * Project one occurrence to {@link GraphSymbolRef}.
 * Returns `undefined` when any identity field is malformed/oversized so the
 * caller can omit the row with partial coverage rather than truncate identity.
 */
export function toGraphSymbolRef(occurrence: FunctionOccurrence): GraphSymbolRef | undefined {
  const packageName = occurrence.package ?? packageFallback(occurrence.filePath);
  if (
    !isControlFreeBounded(occurrence.filePath, GRAPH_SYMBOL_PATH_MAX) ||
    !isControlFreeBounded(occurrence.simpleName, GRAPH_SYMBOL_NAME_MAX) ||
    !isControlFreeBounded(occurrence.qualifiedName, GRAPH_SYMBOL_NAME_MAX) ||
    !isControlFreeBounded(packageName, GRAPH_SYMBOL_PACKAGE_MAX) ||
    !isControlFreeBounded(occurrence.bodyHash, GRAPH_SYMBOL_NAME_MAX)
  ) {
    return undefined;
  }
  if (
    !Number.isFinite(occurrence.line) ||
    occurrence.line < 1 ||
    !Number.isFinite(occurrence.column) ||
    occurrence.column < 0
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

/** Top-level path segment fallback when `occurrence.package` is absent. */
function packageFallback(filePath: string): string {
  const first = filePath.split('/').find((segment) => segment.length > 0);
  return first ?? '(unknown)';
}
