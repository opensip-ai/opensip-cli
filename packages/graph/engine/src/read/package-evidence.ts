/** Canonical package call/import evidence and edge-kind-specific package SCCs. */

import { err, ok, type Result } from '@opensip-cli/core';

import { codePointSortKey, compareCodePointStrings } from '../code-point-order.js';
import { buildFeatures } from '../pipeline/features.js';
import {
  occurrenceCallGraphFor,
  type ResolvedOccurrenceEdge,
} from '../pipeline/occurrence-call-graph.js';

import { coverageFromReasons, insertBoundedTopK, insertUniqueBoundedTopK } from './bounded-view.js';
import {
  graphPackageOf,
  toGraphPackageName,
  toGraphSymbolRef,
  type GeneratedPolicy,
  type GraphReadCoverage,
  type GraphSourceFilter,
  type PackageCallEvidence,
  type PackageEdgeKind,
  type PackageImportEvidence,
  type SourceScope,
} from './query-contracts.js';
import { isCanonicalProductionFilter, matchesGraphSourceFilter } from './source-filter.js';

import type { GraphReadError } from './types.js';
import type {
  Catalog,
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
}

interface PackageEvidenceLabels {
  readonly sourceScope: SourceScope;
  readonly generated: GeneratedPolicy;
  readonly catalogResolutionMode: 'exact' | 'fast';
}

export interface PackageCallEvidenceRow extends PackageEvidenceLabels {
  readonly fromPackage: string;
  readonly toPackage: string;
  readonly kind: 'call';
  /** Canonical resolved static target edges (FeatureTable.edge parity by default). */
  readonly count: number;
  readonly countUnit: 'resolved-targets';
  /** Unique owner/call-site locations contributing to this package pair. */
  readonly callSiteCount: number;
  readonly sample: readonly PackageCallEvidence[];
  readonly coverage: GraphReadCoverage;
}

export interface PackageImportEvidenceRow extends PackageEvidenceLabels {
  readonly fromPackage: string;
  readonly toPackage: string | null;
  /** Internal package name, otherwise the bounded external/unresolved specifier. */
  readonly target: string;
  readonly kind: 'import';
  readonly resolution: PackageImportEvidence['resolution'];
  readonly count: number;
  readonly countUnit: 'import-statements';
  readonly sample: readonly PackageImportEvidence[];
  readonly coverage: GraphReadCoverage;
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
  readonly coverage: GraphReadCoverage;
}

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
const MAX_SAMPLE = 5;
const MAX_IMPORT_TARGETS = 10_000;
const MAX_TARGET_HASH_LENGTH = 128;

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
}

function collectResolvedCallEdge(
  edge: ResolvedOccurrenceEdge,
  query: PackageEvidenceQuery,
  state: CallCollectionState,
): void {
  if (
    !matchesGraphSourceFilter(edge.owner, query.filter) ||
    !matchesGraphSourceFilter(edge.target, query.filter)
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
  if (bucket !== undefined) {
    insertUniqueBoundedTopK(bucket.sample, projected, MAX_SAMPLE, compareCallEvidence);
  }
  state.evidenceCount.value++;
  insertUniqueBoundedTopK(state.evidence, projected, MAX_EVIDENCE, compareCallEvidence);
}

function collectCallBuckets(
  catalog: Catalog,
  indexes: Indexes,
  query: PackageEvidenceQuery,
  reasons: Set<string>,
): {
  buckets: BoundedBucketState<MutableCallBucket>;
  evidence: PackageCallEvidence[];
  totalEvidence: number;
} {
  const buckets: BoundedBucketState<MutableCallBucket> = {
    buckets: new Map(),
    keys: [],
  };
  const evidence: PackageCallEvidence[] = [];
  const evidenceCount = { value: 0 };
  const graph = occurrenceCallGraphFor(indexes);
  const state = { buckets, evidence, evidenceCount, reasons };
  if (graph.malformedCalls > 0) addReason(reasons, 'malformed-call-edge-omitted');

  for (const edge of graph.edges) {
    collectResolvedCallEdge(edge, query, state);
  }
  if (evidenceCount.value > MAX_EVIDENCE) addReason(reasons, 'call-evidence-cap');
  if (modeOf(catalog) === 'fast') addReason(reasons, 'fast-resolution-approximate');
  return { buckets, evidence, totalEvidence: evidenceCount.value };
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
): {
  rows: PackageCallEvidenceRow[];
  evidence: PackageCallEvidence[];
  totalEvidence: number;
} {
  const collected = collectCallBuckets(catalog, indexes, query, reasons);
  const buckets = applyCanonicalCounts({
    catalog,
    indexes,
    query,
    state: collected.buckets,
    reasons,
    cachedFeatures,
  });
  const common = labels(catalog, query.filter);
  const candidates = [...buckets.buckets.values()].map((bucket): PackageCallEvidenceRow => ({
    ...common,
    fromPackage: bucket.fromPackage,
    toPackage: bucket.toPackage,
    kind: 'call',
    count: bucket.resolvedTargets,
    countUnit: 'resolved-targets',
    callSiteCount: bucket.callSites.size,
    sample: bucket.sample,
    coverage: { complete: true, truncated: false, reasons: [] },
  }));
  const coverage = coverageFromReasons(reasons);
  const rows = candidates
    .map((candidate) => ({ ...candidate, coverage }))
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
  readonly workspacePackages: ReadonlySet<string>;
  readonly catalogLanguage: string;
}

function importTargets(
  dependency: { readonly to: readonly string[]; readonly specifier: string },
  context: ImportResolutionContext,
): readonly {
  toPackage: string | null;
  target: string;
  resolution: PackageImportEvidence['resolution'];
}[] {
  const { indexes, reasons, sourcePackage, workspacePackages, catalogLanguage } = context;
  if (dependency.to.length === 0) {
    const resolution =
      catalogLanguage !== 'typescript' ||
      isRelativeSpecifier(dependency.specifier) ||
      workspacePackageForSpecifier(dependency.specifier, workspacePackages) !== undefined
        ? 'unresolved'
        : 'external';
    return [{ toPackage: null, target: dependency.specifier, resolution }];
  }
  const { packages, targetMissing } = collectImportTargetPackages(dependency.to, indexes, reasons);
  if (!targetMissing && packages.size > 0) {
    const selected = disambiguateImportPackage(
      packages,
      dependency.specifier,
      sourcePackage,
      workspacePackages,
    );
    if (selected !== undefined) {
      return [{ toPackage: selected, target: selected, resolution: 'internal' }];
    }
    addReason(reasons, 'ambiguous-import-target');
  }
  return [
    {
      toPackage: null,
      target: dependency.specifier,
      resolution: 'unresolved',
    },
  ];
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

function workspacePackageForSpecifier(
  specifier: string,
  workspacePackages: ReadonlySet<string>,
): string | undefined {
  if (isRelativeSpecifier(specifier)) return undefined;
  const parts = specifier.split('/');
  const root = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
  const leaf = specifier.startsWith('@') ? (parts[1] ?? '') : root;
  const rootMatch = workspacePackages.has(root) ? root : undefined;
  const leafMatch = workspacePackages.has(leaf) ? leaf : undefined;
  // An exact scoped package name is stronger evidence than its compatibility
  // leaf fallback (used by legacy catalogs that stamped only the last segment).
  return rootMatch ?? leafMatch;
}

function disambiguateImportPackage(
  packages: ReadonlySet<string>,
  specifier: string,
  sourcePackage: string,
  workspacePackages: ReadonlySet<string>,
): string | undefined {
  if (packages.size === 1) return packages.values().next().value;
  if (isRelativeSpecifier(specifier) && packages.has(sourcePackage)) return sourcePackage;
  const namedPackage = workspacePackageForSpecifier(specifier, workspacePackages);
  return namedPackage !== undefined && packages.has(namedPackage) ? namedPackage : undefined;
}

function catalogPackageNames(indexes: Indexes): ReadonlySet<string> {
  const packages = new Set<string>();
  for (const occurrence of indexes.byOccId.values()) {
    const packageName = toGraphPackageName(graphPackageOf(occurrence));
    if (packageName !== undefined) packages.add(packageName);
  }
  return packages;
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
): void {
  const bucket = getImportBucket(buckets, evidence, reasons);
  if (bucket !== undefined) {
    bucket.count++;
    insertUniqueBoundedTopK(bucket.sample, evidence, MAX_SAMPLE, compareImportEvidence);
  }
  count.value++;
  insertUniqueBoundedTopK(allEvidence, evidence, MAX_EVIDENCE, compareImportEvidence);
}

function moduleMatchesImportFilter(occurrence: FunctionOccurrence, filter: GraphSourceFilter) {
  if (filter.kinds !== undefined && !filter.kinds.includes('module-init')) return false;
  return matchesGraphSourceFilter(occurrence, filter);
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
  readonly workspacePackages: ReadonlySet<string>;
  readonly catalogLanguage: string;
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
      workspacePackages: context.workspacePackages,
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
      },
      reasons,
      evidenceCount,
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
  if (occurrence.kind !== 'module-init' || !moduleMatchesImportFilter(occurrence, query.filter)) {
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
  const workspacePackages = catalogPackageNames(indexes);
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
    workspacePackages,
    catalogLanguage: catalog.language,
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
  if (evidenceCount.value > MAX_EVIDENCE) addReason(reasons, 'import-evidence-cap');

  const common = labels(catalog, query.filter);
  const candidates = [...buckets.buckets.values()].map((bucket): PackageImportEvidenceRow => ({
    ...common,
    fromPackage: bucket.fromPackage,
    toPackage: bucket.toPackage,
    target: bucket.target,
    kind: 'import',
    resolution: bucket.resolution,
    count: bucket.count,
    countUnit: 'import-statements',
    sample: bucket.sample,
    coverage: { complete: true, truncated: false, reasons: [] },
  }));
  const coverage = coverageFromReasons(reasons);
  const rows = candidates
    .map((candidate) => ({ ...candidate, coverage }))
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
  cachedFeatures?: FeatureTable,
): Result<PackageEvidenceView, GraphReadError> {
  try {
    const callReasons = new Set<string>();
    const importReasons = new Set<string>();
    const calls =
      query.edgeKind === 'call' || query.edgeKind === 'combined'
        ? buildCallRows(catalog, indexes, query, callReasons, cachedFeatures)
        : { rows: [], evidence: [], totalEvidence: 0 };
    const imports =
      query.edgeKind === 'import' || query.edgeKind === 'combined'
        ? buildImportRows(catalog, indexes, query, importReasons)
        : { rows: [], evidence: [], totalEvidence: 0 };
    const reasons = new Set([...callReasons, ...importReasons]);
    return ok({
      calls: calls.rows,
      imports: imports.rows,
      callEvidence: calls.evidence,
      importEvidence: imports.evidence,
      totalCallEvidence: calls.totalEvidence,
      totalImportEvidence: imports.totalEvidence,
      coverage: coverageFromReasons(reasons),
    });
  } catch {
    return err(peError('Failed to build package evidence'));
  }
}
