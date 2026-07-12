/** Canonical package call/import evidence and edge-kind-specific package SCCs. */

import { err, ok, type Result } from '@opensip-cli/core';

import { codePointSortKey, compareCodePointStrings } from '../code-point-order.js';
import { buildFeatures } from '../pipeline/features.js';
import {
  occurrenceCallGraphFor,
  type ResolvedOccurrenceEdge,
} from '../pipeline/occurrence-call-graph.js';

import {
  makeFacet,
  rollupFacets,
  UNREQUESTED_FACET,
  insertBoundedTopK,
  insertUniqueBoundedTopK,
} from './bounded-view.js';
import {
  graphPackageOf,
  toGraphPackageName,
  toGraphSymbolRef,
  type CoverageFacet,
  type GeneratedPolicy,
  type GraphReadFacetCoverage,
  type GraphSourceFilter,
  type PackageCallEvidence,
  type PackageEdgeKind,
  type PackageImportEvidence,
  type SourceScope,
} from './query-contracts.js';
import {
  isCanonicalProductionFilter,
  matchesGraphSourceFilterWithRoles,
  type SourceRoleMatcher,
} from './source-filter.js';

import type { GraphReadError } from './types.js';
import type {
  Catalog,
  DependencyClassification,
  DependencyEdge,
  FeatureTable,
  FunctionOccurrence,
  Indexes,
} from '../types.js';

export interface PackageEvidenceQuery {
  readonly edgeKind: PackageEdgeKind;
  readonly filter: GraphSourceFilter;
  readonly fromPackage?: string;
  readonly toPackage?: string;
  /**
   * Nested sample size per dependency row (P2 Phase 2.3/2.4). Default 5 for the
   * graph/read builder; MCP defaults to 0 (opt-in) at the tool boundary.
   */
  readonly sampleLimit?: number;
  /** Max concrete evidence sites retained for why-depends style inventories. */
  readonly evidenceLimit?: number;
}

interface PackageEvidenceLabels {
  readonly sourceScope: SourceScope;
  readonly generated: GeneratedPolicy;
  readonly catalogResolutionMode: 'exact' | 'fast';
}

/** Per-row sample metadata: empty sample is not "no evidence exists". */
export interface PackageSampleMeta {
  readonly sampleReturned: number;
  readonly sampleAvailable: number;
  readonly sampleLimit: number;
}

export interface PackageCallEvidenceRow extends PackageEvidenceLabels, PackageSampleMeta {
  readonly fromPackage: string;
  readonly toPackage: string;
  readonly kind: 'call';
  /** Canonical resolved static target edges (FeatureTable.edge parity by default). */
  readonly count: number;
  readonly countUnit: 'resolved-targets';
  /** Unique owner/call-site locations contributing to this package pair. */
  readonly callSiteCount: number;
  readonly sample: readonly PackageCallEvidence[];
  /** Inventory completeness for this row's count (not global evidence caps). */
  readonly coverage: CoverageFacet;
}

export interface PackageImportEvidenceRow extends PackageEvidenceLabels, PackageSampleMeta {
  readonly fromPackage: string;
  readonly toPackage: string | null;
  /** Internal package name, otherwise the bounded external/unresolved specifier. */
  readonly target: string;
  readonly kind: 'import';
  readonly resolution: PackageImportEvidence['resolution'];
  readonly count: number;
  readonly countUnit: 'import-statements';
  readonly sample: readonly PackageImportEvidence[];
  /** Inventory completeness for this row's count (not global evidence caps). */
  readonly coverage: CoverageFacet;
}

export interface PackageEvidenceView {
  readonly calls: readonly PackageCallEvidenceRow[];
  readonly imports: readonly PackageImportEvidenceRow[];
  readonly callEvidence: readonly PackageCallEvidence[];
  readonly importEvidence: readonly PackageImportEvidence[];
  /** Matching projectable call evidence before the representative-evidence cap. */
  readonly totalCallEvidence: number;
  /** Matching projectable import evidence before the representative-evidence cap. */
  readonly totalImportEvidence: number;
  /** Facet-specific coverage: inventory vs retained evidence are independent. */
  readonly coverage: GraphReadFacetCoverage;
}

/** Reasons that truncate the retained concrete evidence array only. */
const EVIDENCE_CAP_REASONS = new Set(['call-evidence-cap', 'import-evidence-cap', 'proof-edge-cap']);

interface MutableCallBucket {
  readonly fromPackage: string;
  readonly toPackage: string;
  resolvedTargets: number;
  readonly callSites: Set<string>;
  readonly sample: PackageCallEvidence[];
}

interface MutableImportBucket {
  readonly fromPackage: string;
  readonly toPackage: string | null;
  readonly target: string;
  readonly resolution: PackageImportEvidence['resolution'];
  count: number;
  readonly sample: PackageImportEvidence[];
}

interface BoundedBucketState<T> {
  readonly buckets: Map<string, T>;
  readonly keys: string[];
}

const MAX_SPECIFIER = 512;
const MAX_EDGE_GROUPS = 10_000;
const MAX_EVIDENCE = 10_000;
const DEFAULT_SAMPLE_LIMIT = 5;
const MAX_SAMPLE = 5;
const MAX_IMPORT_TARGETS = 10_000;
const MAX_TARGET_HASH_LENGTH = 128;

function resolveSampleLimit(query: PackageEvidenceQuery): number {
  const raw = query.sampleLimit;
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_SAMPLE_LIMIT;
  return Math.min(MAX_SAMPLE, Math.max(0, Math.trunc(raw)));
}

function resolveEvidenceLimit(query: PackageEvidenceQuery): number {
  const raw = query.evidenceLimit;
  if (raw === undefined || !Number.isFinite(raw)) return MAX_EVIDENCE;
  return Math.min(MAX_EVIDENCE, Math.max(0, Math.trunc(raw)));
}

function partitionPackageReasons(reasons: ReadonlySet<string>): {
  readonly inventory: Set<string>;
  readonly evidence: Set<string>;
} {
  const inventory = new Set<string>();
  const evidence = new Set<string>();
  for (const reason of reasons) {
    if (EVIDENCE_CAP_REASONS.has(reason)) evidence.add(reason);
    else inventory.add(reason);
  }
  return { inventory, evidence };
}

function facetsFromPackageReasons(reasons: ReadonlySet<string>): GraphReadFacetCoverage {
  const parts = partitionPackageReasons(reasons);
  return rollupFacets({
    inventory: makeFacet(true, parts.inventory),
    evidence: makeFacet(parts.evidence.size > 0, parts.evidence),
    grouping: UNREQUESTED_FACET,
    projection: UNREQUESTED_FACET,
  });
}

function completeRowInventory(): CoverageFacet {
  return makeFacet(true, new Set());
}

function addReason(reasons: Set<string>, reason: string): void {
  reasons.add(reason);
}

function peError(message: string): GraphReadError {
  return {
    code: 'GRAPH.READ.PACKAGE_EVIDENCE',
    operation: 'analysis',
    message,
  };
}

function modeOf(catalog: Catalog): 'exact' | 'fast' {
  return catalog.resolutionMode ?? 'exact';
}

function labels(catalog: Catalog, filter: GraphSourceFilter): PackageEvidenceLabels {
  return {
    sourceScope: filter.sourceScope,
    generated: filter.generated,
    catalogResolutionMode: modeOf(catalog),
  };
}

export function packageCallEvidenceStableKey(row: PackageCallEvidence): string {
  return [
    'call',
    codePointSortKey(row.fromPackage),
    codePointSortKey(row.toPackage),
    codePointSortKey(row.from.symbolId),
    codePointSortKey(row.source.file),
    String(row.source.line).padStart(16, '0'),
    String(row.source.column).padStart(16, '0'),
    codePointSortKey(row.to.symbolId),
    row.resolution,
    row.confidence,
    row.crossShard ? '1' : '0',
  ].join('|');
}

export function packageImportEvidenceStableKey(row: PackageImportEvidence): string {
  return [
    'import',
    codePointSortKey(row.fromPackage),
    codePointSortKey(row.target),
    codePointSortKey(row.importSite.filePath),
    String(row.importSite.line).padStart(16, '0'),
    String(row.importSite.column).padStart(16, '0'),
    codePointSortKey(row.specifier),
    row.toPackage === null ? '0' : `1${codePointSortKey(row.toPackage)}`,
    row.resolution,
  ].join('|');
}

export function packageDependencyStableKey(
  row: PackageCallEvidenceRow | PackageImportEvidenceRow,
): string {
  return row.kind === 'call'
    ? `call|${codePointSortKey(row.fromPackage)}|${codePointSortKey(row.toPackage)}`
    : `import|${codePointSortKey(row.fromPackage)}|${codePointSortKey(row.target)}|${row.resolution}`;
}

function compareCallEvidence(a: PackageCallEvidence, b: PackageCallEvidence): number {
  return compareCodePointStrings(packageCallEvidenceStableKey(a), packageCallEvidenceStableKey(b));
}

function compareImportEvidence(a: PackageImportEvidence, b: PackageImportEvidence): number {
  return compareCodePointStrings(
    packageImportEvidenceStableKey(a),
    packageImportEvidenceStableKey(b),
  );
}

function pairAllowed(fromPackage: string, toPackage: string | null, query: PackageEvidenceQuery) {
  if (query.fromPackage !== undefined && fromPackage !== query.fromPackage) return false;
  return query.toPackage === undefined || toPackage === query.toPackage;
}

function callGroupKey(fromPackage: string, toPackage: string): string {
  return `call|${codePointSortKey(fromPackage)}|${codePointSortKey(toPackage)}`;
}

function importGroupKey(evidence: PackageImportEvidence): string {
  return `import|${codePointSortKey(evidence.fromPackage)}|${codePointSortKey(evidence.target)}|${evidence.resolution}`;
}

function boundedBucket<T>(
  state: BoundedBucketState<T>,
  key: string,
  create: () => T,
  reasons: Set<string>,
): T | undefined {
  const existing = state.buckets.get(key);
  if (existing !== undefined) return existing;
  if (state.keys.length >= MAX_EDGE_GROUPS) {
    addReason(reasons, 'package-edge-group-cap');
    const largest = state.keys.at(-1);
    if (largest === undefined || compareCodePointStrings(key, largest) >= 0) return undefined;
    state.keys.pop();
    state.buckets.delete(largest);
  }
  const created = create();
  insertBoundedTopK(state.keys, key, MAX_EDGE_GROUPS, compareCodePointStrings);
  state.buckets.set(key, created);
  return created;
}

function getCallBucket(
  state: BoundedBucketState<MutableCallBucket>,
  fromPackage: string,
  toPackage: string,
  reasons: Set<string>,
): MutableCallBucket | undefined {
  return boundedBucket(
    state,
    callGroupKey(fromPackage, toPackage),
    () => ({
      fromPackage,
      toPackage,
      resolvedTargets: 0,
      callSites: new Set(),
      sample: [],
    }),
    reasons,
  );
}

function projectCallEvidence(
  edge: ResolvedOccurrenceEdge,
  fromPackage: string,
  toPackage: string,
): PackageCallEvidence | undefined {
  const from = toGraphSymbolRef(edge.owner);
  const to = toGraphSymbolRef(edge.target);
  if (from === undefined || to === undefined) return undefined;
  return {
    kind: 'call',
    fromPackage,
    toPackage,
    from,
    to,
    source: {
      file: edge.owner.filePath,
      line: edge.callSite.line,
      column: edge.callSite.column,
    },
    resolution: edge.resolution,
    confidence: edge.confidence,
    crossShard: edge.crossShard,
  };
}

interface CallCollectionState {
  readonly buckets: BoundedBucketState<MutableCallBucket>;
  readonly evidence: PackageCallEvidence[];
  readonly evidenceCount: { value: number };
  readonly reasons: Set<string>;
  readonly matcher: SourceRoleMatcher;
  readonly sampleLimit: number;
  readonly evidenceLimit: number;
}

function collectResolvedCallEdge(
  edge: ResolvedOccurrenceEdge,
  query: PackageEvidenceQuery,
  state: CallCollectionState,
): void {
  if (
    !matchesGraphSourceFilterWithRoles(edge.owner, query.filter, state.matcher) ||
    !matchesGraphSourceFilterWithRoles(edge.target, query.filter, state.matcher)
  ) {
    return;
  }
  const fromPackage = toGraphPackageName(graphPackageOf(edge.owner));
  const toPackage = toGraphPackageName(graphPackageOf(edge.target));
  if (fromPackage === undefined || toPackage === undefined) {
    addReason(state.reasons, 'malformed-package-omitted');
    return;
  }
  if (!pairAllowed(fromPackage, toPackage, query)) return;
  const bucket = getCallBucket(state.buckets, fromPackage, toPackage, state.reasons);
  if (bucket !== undefined) {
    bucket.resolvedTargets++;
    bucket.callSites.add(
      `${edge.fromOccId}\0${String(edge.callSite.line)}\0${String(edge.callSite.column)}`,
    );
  }
  const projected = projectCallEvidence(edge, fromPackage, toPackage);
  if (projected === undefined) {
    addReason(state.reasons, 'malformed-symbol-omitted');
    return;
  }
  if (bucket !== undefined && state.sampleLimit > 0) {
    insertUniqueBoundedTopK(bucket.sample, projected, state.sampleLimit, compareCallEvidence);
  }
  state.evidenceCount.value++;
  if (state.evidenceLimit > 0) {
    insertUniqueBoundedTopK(state.evidence, projected, state.evidenceLimit, compareCallEvidence);
  }
}

function collectCallBuckets(
  catalog: Catalog,
  indexes: Indexes,
  query: PackageEvidenceQuery,
  reasons: Set<string>,
  matcher: SourceRoleMatcher,
): {
  buckets: BoundedBucketState<MutableCallBucket>;
  evidence: PackageCallEvidence[];
  totalEvidence: number;
  sampleLimit: number;
} {
  const buckets: BoundedBucketState<MutableCallBucket> = {
    buckets: new Map(),
    keys: [],
  };
  const evidence: PackageCallEvidence[] = [];
  const evidenceCount = { value: 0 };
  const sampleLimit = resolveSampleLimit(query);
  const evidenceLimit = resolveEvidenceLimit(query);
  const graph = occurrenceCallGraphFor(indexes);
  const state: CallCollectionState = {
    buckets,
    evidence,
    evidenceCount,
    reasons,
    matcher,
    sampleLimit,
    evidenceLimit,
  };
  if (graph.malformedCalls > 0) addReason(reasons, 'malformed-call-edge-omitted');

  for (const edge of graph.edges) {
    collectResolvedCallEdge(edge, query, state);
  }
  // Cap reason is evidence-only: bucket counts remain complete from the full walk.
  if (evidenceCount.value > evidenceLimit) addReason(reasons, 'call-evidence-cap');
  if (modeOf(catalog) === 'fast') addReason(reasons, 'fast-resolution-approximate');
  return { buckets, evidence, totalEvidence: evidenceCount.value, sampleLimit };
}

interface CanonicalCountInput {
  readonly catalog: Catalog;
  readonly indexes: Indexes;
  readonly query: PackageEvidenceQuery;
  readonly state: BoundedBucketState<MutableCallBucket>;
  readonly reasons: Set<string>;
  readonly cachedFeatures: FeatureTable | undefined;
}

function applyCanonicalCounts(input: CanonicalCountInput): BoundedBucketState<MutableCallBucket> {
  const { catalog, indexes, query, state, reasons, cachedFeatures } = input;
  if (!isCanonicalProductionFilter(query.filter)) return state;
  const canonical: BoundedBucketState<MutableCallBucket> = {
    buckets: new Map(),
    keys: [],
  };
  const features = cachedFeatures ?? buildFeatures(catalog, indexes, {}, ['packageCoupling']);
  for (const row of features.edge) {
    if (!pairAllowed(row.callerPackage, row.calleePackage, query)) continue;
    const fromPackage = toGraphPackageName(row.callerPackage);
    const toPackage = toGraphPackageName(row.calleePackage);
    if (fromPackage === undefined || toPackage === undefined) {
      addReason(reasons, 'malformed-package-omitted');
      continue;
    }
    const prior = state.buckets.get(callGroupKey(fromPackage, toPackage));
    const bucket = boundedBucket(
      canonical,
      callGroupKey(fromPackage, toPackage),
      () => ({
        fromPackage,
        toPackage,
        resolvedTargets: 0,
        callSites: prior?.callSites ?? new Set(),
        sample: prior?.sample ?? [],
      }),
      reasons,
    );
    if (bucket !== undefined) bucket.resolvedTargets = row.count;
  }
  return canonical;
}

function buildCallRows(
  catalog: Catalog,
  indexes: Indexes,
  query: PackageEvidenceQuery,
  reasons: Set<string>,
  cachedFeatures: FeatureTable | undefined,
  matcher: SourceRoleMatcher,
): {
  rows: PackageCallEvidenceRow[];
  evidence: PackageCallEvidence[];
  totalEvidence: number;
} {
  const collected = collectCallBuckets(catalog, indexes, query, reasons, matcher);
  const buckets = applyCanonicalCounts({
    catalog,
    indexes,
    query,
    state: collected.buckets,
    reasons,
    cachedFeatures,
  });
  const common = labels(catalog, query.filter);
  const sampleLimit = collected.sampleLimit;
  const rows = [...buckets.buckets.values()]
    .map(
      (bucket): PackageCallEvidenceRow => ({
        ...common,
        fromPackage: bucket.fromPackage,
        toPackage: bucket.toPackage,
        kind: 'call',
        count: bucket.resolvedTargets,
        countUnit: 'resolved-targets',
        callSiteCount: bucket.callSites.size,
        sample: bucket.sample,
        sampleReturned: bucket.sample.length,
        sampleAvailable: bucket.callSites.size,
        sampleLimit,
        // Row inventory is complete whenever the bucket was retained; global caps
        // never stamp onto individual row coverage.
        coverage: completeRowInventory(),
      }),
    )
    .sort((a, b) =>
      compareCodePointStrings(packageDependencyStableKey(a), packageDependencyStableKey(b)),
    );
  return {
    rows,
    evidence: collected.evidence,
    totalEvidence: collected.totalEvidence,
  };
}

function stripAndBoundSpecifier(value: string): {
  readonly value: string;
  readonly sanitized: boolean;
  readonly capped: boolean;
} {
  let out = '';
  let sanitized = false;
  let count = 0;
  for (const character of value) {
    if (/\p{Cc}/u.test(character)) {
      sanitized = true;
      continue;
    }
    if (count >= MAX_SPECIFIER) return { value: out, sanitized, capped: true };
    out += character;
    count++;
  }
  return { value: out, sanitized, capped: false };
}

interface ImportResolutionContext {
  readonly indexes: Indexes;
  readonly reasons: Set<string>;
  readonly sourcePackage: string;
  readonly catalogLanguage: string;
}

interface ImportTargetResult {
  readonly toPackage: string | null;
  readonly target: string;
  readonly resolution: PackageImportEvidence['resolution'];
  readonly classification?: DependencyClassification;
  readonly confidence?: 'high';
}

/**
 * Resolve one persisted dependency edge to package-import evidence (P2 Phase 0.3).
 * Target hashes → the unique catalog package (`catalog-target`, high confidence).
 * No hashes but a persisted `resolvedPackage` (a `.d.ts` declaration entry the
 * adapter/global-merge attributed to a unique workspace package) → internal
 * `workspace-manifest` evidence. Everything else — ambiguous targets, external,
 * or a relative miss — is `unresolved`/`external`, carrying the persisted
 * classification and reason. No leaf-name / first-wins inference.
 */
interface ClassificationSpread {
  readonly classification?: DependencyClassification;
}

function importTargets(
  dependency: {
    readonly to: readonly string[];
    readonly specifier: string;
    readonly classification?: DependencyClassification;
  },
  context: ImportResolutionContext,
): readonly ImportTargetResult[] {
  const classification = dependency.classification;
  const withClass: ClassificationSpread =
    classification === undefined ? {} : { classification };
  return dependency.to.length > 0
    ? resolveFromTargetHashes(dependency, context, withClass)
    : resolveFromEmptyTargets(dependency, classification, context.catalogLanguage, withClass);
}

/** Attribute a dependency whose target body hashes are present in the catalog. */
function resolveFromTargetHashes(
  dependency: { readonly to: readonly string[]; readonly specifier: string },
  context: ImportResolutionContext,
  withClass: ClassificationSpread,
): readonly ImportTargetResult[] {
  const { indexes, reasons, sourcePackage } = context;
  const { packages, targetMissing } = collectImportTargetPackages(dependency.to, indexes, reasons);
  if (!targetMissing && packages.size === 1) {
    const selected = packages.values().next().value!;
    return [{ toPackage: selected, target: selected, resolution: 'internal', ...withClass, confidence: 'high' }];
  }
  // A relative same-package import whose body-twin resolves into several
  // packages is attributed to its own source package — not first-wins.
  if (packages.size > 1 && isRelativeSpecifier(dependency.specifier) && packages.has(sourcePackage)) {
    return [{ toPackage: sourcePackage, target: sourcePackage, resolution: 'internal', ...withClass, confidence: 'high' }];
  }
  if (packages.size > 1) addReason(reasons, 'ambiguous-import-target');
  return [{ toPackage: null, target: dependency.specifier, resolution: 'unresolved', ...withClass }];
}

/**
 * Attribute a dependency with no catalog target body hashes: a `.d.ts`
 * declaration entry the adapter/global-merge attributed to a unique workspace
 * package resolves internal on its persisted `resolvedPackage`; everything else
 * is external or unresolved per the persisted classification (or, for a
 * pre-feature edge, the language/specifier heuristic).
 */
function resolveFromEmptyTargets(
  dependency: { readonly specifier: string },
  classification: DependencyClassification | undefined,
  catalogLanguage: string,
  withClass: ClassificationSpread,
): readonly ImportTargetResult[] {
  if (classification?.resolvedPackage !== undefined) {
    return [
      {
        toPackage: classification.resolvedPackage,
        target: classification.resolvedPackage,
        resolution: 'internal',
        classification,
        confidence: 'high',
      },
    ];
  }
  const resolution = emptyTargetResolution(classification, dependency.specifier, catalogLanguage);
  return [{ toPackage: null, target: dependency.specifier, resolution, ...withClass }];
}

function emptyTargetResolution(
  classification: DependencyClassification | undefined,
  specifier: string,
  catalogLanguage: string,
): PackageImportEvidence['resolution'] {
  if (classification !== undefined) {
    return classification.targetKind === 'external' ? 'external' : 'unresolved';
  }
  // Pre-feature edge (no classification): a bare TypeScript specifier is external;
  // a relative miss or any non-TypeScript specifier is unresolved.
  return catalogLanguage === 'typescript' && !isRelativeSpecifier(specifier)
    ? 'external'
    : 'unresolved';
}

function collectImportTargetPackages(
  hashes: readonly string[],
  indexes: Indexes,
  reasons: Set<string>,
): { readonly packages: ReadonlySet<string>; readonly targetMissing: boolean } {
  const packages = new Set<string>();
  let targetMissing = false;
  for (const hash of hashes) {
    const packagesForHash = new Set<string>();
    for (const target of indexes.occurrencesByHash.get(hash) ?? []) {
      const packageName = toGraphPackageName(graphPackageOf(target));
      if (packageName === undefined) addReason(reasons, 'malformed-package-omitted');
      else packagesForHash.add(packageName);
    }
    if (packagesForHash.size === 0) targetMissing = true;
    for (const packageName of packagesForHash) packages.add(packageName);
  }
  return { packages, targetMissing };
}

function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/') ||
    specifier.startsWith('\\')
  );
}

function getImportBucket(
  buckets: BoundedBucketState<MutableImportBucket>,
  evidence: PackageImportEvidence,
  reasons: Set<string>,
): MutableImportBucket | undefined {
  return boundedBucket(
    buckets,
    importGroupKey(evidence),
    () => ({
      fromPackage: evidence.fromPackage,
      toPackage: evidence.toPackage,
      target: evidence.target,
      resolution: evidence.resolution,
      count: 0,
      sample: [],
    }),
    reasons,
  );
}

function appendImportEvidence(
  buckets: BoundedBucketState<MutableImportBucket>,
  allEvidence: PackageImportEvidence[],
  evidence: PackageImportEvidence,
  reasons: Set<string>,
  count: { value: number },
  limits: { readonly sampleLimit: number; readonly evidenceLimit: number },
): void {
  const bucket = getImportBucket(buckets, evidence, reasons);
  if (bucket !== undefined) {
    bucket.count++;
    if (limits.sampleLimit > 0) {
      insertUniqueBoundedTopK(bucket.sample, evidence, limits.sampleLimit, compareImportEvidence);
    }
  }
  count.value++;
  if (limits.evidenceLimit > 0) {
    insertUniqueBoundedTopK(allEvidence, evidence, limits.evidenceLimit, compareImportEvidence);
  }
}

function moduleMatchesImportFilter(
  occurrence: FunctionOccurrence,
  filter: GraphSourceFilter,
  matcher: SourceRoleMatcher,
) {
  if (filter.kinds !== undefined && !filter.kinds.includes('module-init')) return false;
  return matchesGraphSourceFilterWithRoles(occurrence, filter, matcher);
}

interface ImportCollectionState {
  moduleCount: number;
  missingDependencyPayload: boolean;
}

interface ImportCollectionContext {
  readonly indexes: Indexes;
  readonly query: PackageEvidenceQuery;
  readonly buckets: BoundedBucketState<MutableImportBucket>;
  readonly evidence: PackageImportEvidence[];
  readonly reasons: Set<string>;
  readonly evidenceCount: { value: number };
  readonly catalogLanguage: string;
  readonly matcher: SourceRoleMatcher;
  readonly sampleLimit: number;
  readonly evidenceLimit: number;
}

function collectDependencyImports(
  dependency: DependencyEdge,
  source: { readonly fromPackage: string; readonly filePath: string },
  context: ImportCollectionContext,
): void {
  const { query, buckets, evidence, reasons, evidenceCount } = context;
  const boundedSpecifier = stripAndBoundSpecifier(dependency.specifier);
  const specifier = boundedSpecifier.value;
  if (boundedSpecifier.sanitized) addReason(reasons, 'specifier-sanitized');
  if (boundedSpecifier.capped) addReason(reasons, 'specifier-cap');
  if (
    specifier.length === 0 ||
    !Number.isSafeInteger(dependency.line) ||
    dependency.line < 1 ||
    !Number.isSafeInteger(dependency.column) ||
    dependency.column < 0
  ) {
    addReason(reasons, 'malformed-import-evidence-omitted');
    return;
  }
  for (const target of importTargets(
    { ...dependency, specifier },
    {
      indexes: context.indexes,
      reasons,
      sourcePackage: source.fromPackage,
      catalogLanguage: context.catalogLanguage,
    },
  )) {
    if (!pairAllowed(source.fromPackage, target.toPackage, query)) continue;
    appendImportEvidence(
      buckets,
      evidence,
      {
        fromPackage: source.fromPackage,
        toPackage: target.toPackage,
        target: target.target,
        kind: 'import',
        resolution: target.resolution,
        specifier,
        importSite: {
          filePath: source.filePath,
          line: dependency.line,
          column: dependency.column,
        },
        ...(target.classification === undefined ? {} : { classification: target.classification }),
        ...(target.confidence === undefined ? {} : { confidence: target.confidence }),
      },
      reasons,
      evidenceCount,
      { sampleLimit: context.sampleLimit, evidenceLimit: context.evidenceLimit },
    );
  }
}

function isSafeDependencyEdge(value: unknown): value is DependencyEdge {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const edge = value as Record<string, unknown>;
  return (
    Array.isArray(edge.to) &&
    edge.to.length <= MAX_IMPORT_TARGETS &&
    edge.to.every(
      (target) =>
        typeof target === 'string' &&
        target.length > 0 &&
        target.length <= MAX_TARGET_HASH_LENGTH &&
        !/\p{Cc}/u.test(target),
    ) &&
    typeof edge.specifier === 'string' &&
    Number.isSafeInteger(edge.line) &&
    (edge.line as number) >= 1 &&
    Number.isSafeInteger(edge.column) &&
    (edge.column as number) >= 0
  );
}

function collectOccurrenceImports(
  occurrence: FunctionOccurrence,
  context: ImportCollectionContext,
  state: ImportCollectionState,
): void {
  const { query, reasons } = context;
  if (
    occurrence.kind !== 'module-init' ||
    !moduleMatchesImportFilter(occurrence, query.filter, context.matcher)
  ) {
    return;
  }
  state.moduleCount++;
  if (occurrence.dependencies === undefined) {
    state.missingDependencyPayload = true;
    return;
  }
  const fromPackage = toGraphPackageName(graphPackageOf(occurrence));
  const symbol = toGraphSymbolRef(occurrence);
  if (fromPackage === undefined || symbol === undefined) {
    addReason(reasons, 'malformed-import-source-omitted');
    return;
  }
  for (const dependency of occurrence.dependencies as readonly unknown[]) {
    if (!isSafeDependencyEdge(dependency)) {
      addReason(reasons, 'malformed-import-evidence-omitted');
      continue;
    }
    collectDependencyImports(dependency, { fromPackage, filePath: symbol.filePath }, context);
  }
}

function buildImportRows(
  catalog: Catalog,
  indexes: Indexes,
  query: PackageEvidenceQuery,
  reasons: Set<string>,
  matcher: SourceRoleMatcher,
): {
  rows: PackageImportEvidenceRow[];
  evidence: PackageImportEvidence[];
  totalEvidence: number;
} {
  const buckets: BoundedBucketState<MutableImportBucket> = {
    buckets: new Map(),
    keys: [],
  };
  const evidence: PackageImportEvidence[] = [];
  const evidenceCount = { value: 0 };
  const sampleLimit = resolveSampleLimit(query);
  const evidenceLimit = resolveEvidenceLimit(query);
  const state: ImportCollectionState = {
    moduleCount: 0,
    missingDependencyPayload: false,
  };
  const context: ImportCollectionContext = {
    indexes,
    query,
    buckets,
    evidence,
    reasons,
    evidenceCount,
    catalogLanguage: catalog.language,
    matcher,
    sampleLimit,
    evidenceLimit,
  };

  for (const occurrence of indexes.byOccId.values()) {
    collectOccurrenceImports(occurrence, context, state);
  }

  const kindsExcludeModules =
    query.filter.kinds !== undefined && !query.filter.kinds.includes('module-init');
  if (!kindsExcludeModules && (state.moduleCount === 0 || state.missingDependencyPayload)) {
    addReason(reasons, 'dependency-edges-unavailable');
  }
  if (modeOf(catalog) === 'fast') addReason(reasons, 'fast-import-coverage-partial');
  if (evidenceCount.value > evidenceLimit) addReason(reasons, 'import-evidence-cap');

  const common = labels(catalog, query.filter);
  const rows = [...buckets.buckets.values()]
    .map(
      (bucket): PackageImportEvidenceRow => ({
        ...common,
        fromPackage: bucket.fromPackage,
        toPackage: bucket.toPackage,
        target: bucket.target,
        kind: 'import',
        resolution: bucket.resolution,
        count: bucket.count,
        countUnit: 'import-statements',
        sample: bucket.sample,
        sampleReturned: bucket.sample.length,
        sampleAvailable: bucket.count,
        sampleLimit,
        coverage: completeRowInventory(),
      }),
    )
    .sort((a, b) =>
      compareCodePointStrings(packageDependencyStableKey(a), packageDependencyStableKey(b)),
    );
  return { rows, evidence, totalEvidence: evidenceCount.value };
}

/** Build package call/import rows plus bounded concrete evidence. */
export function buildPackageEvidence(
  catalog: Catalog,
  indexes: Indexes,
  query: PackageEvidenceQuery,
  matcher: SourceRoleMatcher,
  cachedFeatures?: FeatureTable,
): Result<PackageEvidenceView, GraphReadError> {
  try {
    const callReasons = new Set<string>();
    const importReasons = new Set<string>();
    const calls =
      query.edgeKind === 'call' || query.edgeKind === 'combined'
        ? buildCallRows(catalog, indexes, query, callReasons, cachedFeatures, matcher)
        : { rows: [], evidence: [], totalEvidence: 0 };
    const imports =
      query.edgeKind === 'import' || query.edgeKind === 'combined'
        ? buildImportRows(catalog, indexes, query, importReasons, matcher)
        : { rows: [], evidence: [], totalEvidence: 0 };
    const reasons = new Set([...callReasons, ...importReasons]);
    return ok({
      calls: calls.rows,
      imports: imports.rows,
      callEvidence: calls.evidence,
      importEvidence: imports.evidence,
      totalCallEvidence: calls.totalEvidence,
      totalImportEvidence: imports.totalEvidence,
      coverage: facetsFromPackageReasons(reasons),
    });
  } catch {
    return err(peError('Failed to build package evidence'));
  }
}
