/**
 * Shared identity, sort, merge, and cap helpers for the optional semantic
 * declaration/reference plane (P2 MCP audit Phase 3).
 *
 * Pure data only — no compiler, filesystem, or repository coupling. Producers,
 * shard merge, incremental rebuild, and the global reconciler all share these
 * recipes so fact IDs and order stay generation-stable.
 */

import { createHash } from 'node:crypto';

import { compareCodePointStrings } from './code-point-order.js';
import { DEFAULT_SEMANTIC_FACT_LIMITS, MAX_SEMANTIC_TEXT } from './types.js';

import type {
  CrossFileReferenceFact,
  DeclarationFact,
  SemanticFactBundle,
  SemanticFactLimits,
  SemanticFactProducerCoverage,
} from './types.js';

/**
 * Escape `|` and `\` in identity segments so join-based ids stay reversible
 * without hex-encoding every code point (which blows past MAX_SEMANTIC_TEXT).
 */
function idSegment(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('|', '\\|');
}

/**
 * Bound a composite id to {@link MAX_SEMANTIC_TEXT} so it always survives the
 * read-time validator (which rejects any id longer than `maxText`). Individual
 * segments are already bounded, but their concatenation (e.g. a ~1000-char
 * filePath) can still exceed the limit; a pathologically long id collapses to
 * its `<prefix>|~<sha256>` — deterministic, collision-resistant, and stable
 * across runs so declaration/reference ids still join by equality. The `<prefix>|`
 * head is preserved so id-shape guards keep working. (P2 Phase 3 — id-length brick fix.)
 */
function boundId(prefix: 'd1' | 'r1', raw: string): string {
  if (raw.length <= MAX_SEMANTIC_TEXT) return raw;
  return `${prefix}|~${createHash('sha256').update(raw).digest('base64url')}`;
}

/** Build a stable declaration id from normalized identity inputs. */
export function makeDeclarationId(input: {
  readonly package: string;
  readonly filePath: string;
  readonly kind: string;
  readonly name: string;
  readonly line: number;
  readonly column: number;
}): string {
  return boundId(
    'd1',
    [
      'd1',
      idSegment(input.package),
      idSegment(input.filePath),
      idSegment(input.kind),
      idSegment(input.name),
      String(input.line),
      String(input.column),
    ].join('|'),
  );
}

/** Build a stable reference id from source span + kind + target fingerprint. */
export function makeReferenceId(input: {
  readonly filePath: string;
  readonly kind: string;
  readonly line: number;
  readonly column: number;
  readonly targetDeclarationId?: string;
  readonly targetName?: string;
  readonly targetPackage?: string;
}): string {
  return boundId(
    'r1',
    [
      'r1',
      idSegment(input.filePath),
      idSegment(input.kind),
      String(input.line),
      String(input.column),
      idSegment(input.targetDeclarationId ?? ''),
      idSegment(input.targetPackage ?? ''),
      idSegment(input.targetName ?? ''),
    ].join('|'),
  );
}

/** Deterministic declaration order: package, path, line, column, id. */
export function compareDeclarationFacts(a: DeclarationFact, b: DeclarationFact): number {
  return (
    compareCodePointStrings(a.package, b.package) ||
    compareCodePointStrings(a.filePath, b.filePath) ||
    a.line - b.line ||
    a.column - b.column ||
    compareCodePointStrings(a.declarationId, b.declarationId)
  );
}

/** Deterministic reference order: path, line, column, kind, id. */
export function compareReferenceFacts(
  a: CrossFileReferenceFact,
  b: CrossFileReferenceFact,
): number {
  return (
    compareCodePointStrings(a.filePath, b.filePath) ||
    a.line - b.line ||
    a.column - b.column ||
    compareCodePointStrings(a.kind, b.kind) ||
    compareCodePointStrings(a.referenceId, b.referenceId)
  );
}

/** Sort and de-duplicate reasons for stable coverage payloads. */
export function sortReasonCodes(reasons: readonly string[]): readonly string[] {
  return [...new Set(reasons)].sort(compareCodePointStrings);
}

/**
 * Merge producer coverage conservatively: partial if any input is partial,
 * sum counters, union reason codes.
 */
export function mergeProducerCoverage(
  coverages: readonly SemanticFactProducerCoverage[],
): SemanticFactProducerCoverage {
  if (coverages.length === 0) {
    return {
      status: 'complete',
      inspectedDeclarations: 0,
      emittedDeclarations: 0,
      omittedDeclarations: 0,
      inspectedReferences: 0,
      emittedReferences: 0,
      omittedReferences: 0,
      reasons: [],
    };
  }
  let status: 'complete' | 'partial' = 'complete';
  let inspectedDeclarations = 0;
  let emittedDeclarations = 0;
  let omittedDeclarations = 0;
  let inspectedReferences = 0;
  let emittedReferences = 0;
  let omittedReferences = 0;
  const reasons: string[] = [];
  for (const c of coverages) {
    if (c.status === 'partial') status = 'partial';
    inspectedDeclarations += c.inspectedDeclarations;
    emittedDeclarations += c.emittedDeclarations;
    omittedDeclarations += c.omittedDeclarations;
    inspectedReferences += c.inspectedReferences;
    emittedReferences += c.emittedReferences;
    omittedReferences += c.omittedReferences;
    reasons.push(...c.reasons);
  }
  return {
    status,
    inspectedDeclarations,
    emittedDeclarations,
    omittedDeclarations,
    inspectedReferences,
    emittedReferences,
    omittedReferences,
    reasons: sortReasonCodes(reasons),
  };
}

/**
 * After retention, re-sync emitted counts with actual arrays and mark partial
 * when reasons remain (or when caps truncated).
 */
export function finalizeProducerCoverage(
  coverage: SemanticFactProducerCoverage,
  declarations: readonly DeclarationFact[],
  references: readonly CrossFileReferenceFact[],
): SemanticFactProducerCoverage {
  const reasons = sortReasonCodes(coverage.reasons);
  const partial =
    coverage.status === 'partial' ||
    reasons.length > 0 ||
    declarations.length < coverage.emittedDeclarations ||
    references.length < coverage.emittedReferences;
  return {
    status: partial ? 'partial' : 'complete',
    inspectedDeclarations: coverage.inspectedDeclarations,
    emittedDeclarations: declarations.length,
    omittedDeclarations: Math.max(
      0,
      coverage.omittedDeclarations +
        Math.max(0, coverage.emittedDeclarations - declarations.length),
    ),
    inspectedReferences: coverage.inspectedReferences,
    emittedReferences: references.length,
    omittedReferences: Math.max(
      0,
      coverage.omittedReferences + Math.max(0, coverage.emittedReferences - references.length),
    ),
    reasons,
  };
}

/**
 * Apply global caps: keep deterministic top-K by stable identity order, then
 * enforce referential closure — either retain referenced declarations that
 * would fall outside the declaration cap, or downgrade dangling references
 * with `target-omitted-by-cap`. Never emit a dangling targetDeclarationId.
 */
export function applySemanticFactCaps(
  declarations: readonly DeclarationFact[],
  references: readonly CrossFileReferenceFact[],
  coverage: SemanticFactProducerCoverage,
  limits: SemanticFactLimits = DEFAULT_SEMANTIC_FACT_LIMITS,
): SemanticFactBundle {
  const sortedDecls = [...declarations].sort(compareDeclarationFacts);
  const sortedRefs = [...references].sort(compareReferenceFacts);
  const reasons = [...coverage.reasons];

  // First pass: prefer references in identity order under the reference cap.
  let keptRefs = sortedRefs;
  if (sortedRefs.length > limits.maxReferences) {
    keptRefs = sortedRefs.slice(0, limits.maxReferences);
    reasons.push('reference-cap');
  }

  // Per-declaration reference soft bound (deterministic: first N by ref order).
  keptRefs = applyPerDeclarationCap(keptRefs, limits, reasons);

  // Declaration cap: keep top-K, then restore any still-referenced ids.
  const referencedIds = new Set<string>();
  for (const ref of keptRefs) {
    if (ref.targetDeclarationId !== undefined) referencedIds.add(ref.targetDeclarationId);
  }

  const capped = applyDeclarationCap(sortedDecls, keptRefs, referencedIds, limits, reasons);

  const finalCoverage = finalizeProducerCoverage(
    {
      ...coverage,
      reasons: sortReasonCodes(reasons),
      status: reasons.length > 0 || coverage.status === 'partial' ? 'partial' : coverage.status,
    },
    capped.keptDecls,
    capped.keptRefs,
  );

  return {
    referenceScope: 'cross-file',
    declarations: capped.keptDecls,
    references: capped.keptRefs,
    coverage: finalCoverage,
  };
}

/**
 * Per-declaration reference soft bound (deterministic: first N by ref order).
 * Pushes `references-per-declaration-cap` when any reference is dropped.
 */
function applyPerDeclarationCap(
  keptRefs: readonly CrossFileReferenceFact[],
  limits: SemanticFactLimits,
  reasons: string[],
): CrossFileReferenceFact[] {
  const perDeclCounts = new Map<string, number>();
  const afterPerDecl: CrossFileReferenceFact[] = [];
  let perDeclOmitted = 0;
  for (const ref of keptRefs) {
    const target = ref.targetDeclarationId;
    if (target === undefined) {
      afterPerDecl.push(ref);
      continue;
    }
    const n = (perDeclCounts.get(target) ?? 0) + 1;
    if (n > limits.maxReferencesPerDeclaration) {
      perDeclOmitted++;
      continue;
    }
    perDeclCounts.set(target, n);
    afterPerDecl.push(ref);
  }
  if (perDeclOmitted > 0) {
    reasons.push('references-per-declaration-cap');
  }
  return afterPerDecl;
}

/**
 * Declaration cap: keep top-K, restore still-referenced ids under a modest
 * closure overflow, otherwise downgrade references whose targets fall outside.
 */
function applyDeclarationCap(
  sortedDecls: readonly DeclarationFact[],
  keptRefs: CrossFileReferenceFact[],
  referencedIds: ReadonlySet<string>,
  limits: SemanticFactLimits,
  reasons: string[],
): { readonly keptDecls: readonly DeclarationFact[]; readonly keptRefs: CrossFileReferenceFact[] } {
  if (sortedDecls.length <= limits.maxDeclarations) {
    const ids = new Set(sortedDecls.map((d) => d.declarationId));
    return { keptDecls: sortedDecls, keptRefs: downgradeMissingTargets(keptRefs, ids, reasons) };
  }

  const primary = sortedDecls.slice(0, limits.maxDeclarations);
  const primaryIds = new Set(primary.map((d) => d.declarationId));
  const closureExtras: DeclarationFact[] = [];
  for (const d of sortedDecls.slice(limits.maxDeclarations)) {
    if (referencedIds.has(d.declarationId) && !primaryIds.has(d.declarationId)) {
      closureExtras.push(d);
    }
  }
  // Prefer referential closure when extras fit under a modest overflow of the
  // cap; otherwise downgrade references whose targets fall outside.
  const withClosure = [...primary, ...closureExtras].sort(compareDeclarationFacts);
  if (withClosure.length > limits.maxDeclarations + Math.min(1000, limits.maxDeclarations)) {
    reasons.push('declaration-cap');
    return { keptDecls: primary, keptRefs: downgradeMissingTargets(keptRefs, primaryIds, reasons) };
  }
  // Still over hard cap when closure is large — keep primary only and downgrade.
  if (withClosure.length > limits.maxDeclarations && closureExtras.length > 0) {
    reasons.push('declaration-cap');
    return { keptDecls: primary, keptRefs: downgradeMissingTargets(keptRefs, primaryIds, reasons) };
  }
  const keptDecls = withClosure.slice(0, limits.maxDeclarations);
  if (sortedDecls.length > keptDecls.length) reasons.push('declaration-cap');
  const ids = new Set(keptDecls.map((d) => d.declarationId));
  return { keptDecls, keptRefs: downgradeMissingTargets(keptRefs, ids, reasons) };
}

function downgradeMissingTargets(
  refs: readonly CrossFileReferenceFact[],
  declIds: ReadonlySet<string>,
  reasons: string[],
): CrossFileReferenceFact[] {
  let downgraded = 0;
  const out = refs.map((ref) => {
    if (ref.targetDeclarationId === undefined || declIds.has(ref.targetDeclarationId)) {
      return ref;
    }
    downgraded++;
    return {
      ...ref,
      targetDeclarationId: undefined,
      basis: 'unresolved' as const,
      confidence: 'low' as const,
      reason: 'target-omitted-by-cap',
      referenceId: makeReferenceId({
        filePath: ref.filePath,
        kind: ref.kind,
        line: ref.line,
        column: ref.column,
        targetName: ref.targetName,
        targetPackage: ref.targetPackage,
      }),
    };
  });
  if (downgraded > 0) reasons.push('target-omitted-by-cap');
  // Re-sort after id changes and de-dupe by referenceId.
  const seen = new Set<string>();
  const deduped: CrossFileReferenceFact[] = [];
  for (const ref of [...out].sort(compareReferenceFacts)) {
    if (seen.has(ref.referenceId)) continue;
    seen.add(ref.referenceId);
    deduped.push(ref);
  }
  return deduped;
}

/**
 * Union semantic fact bundles by stable identity, sort, merge coverage, and
 * re-apply caps. Absent inputs are ignored; if every input is absent, returns
 * `undefined` (unsupported). Present-empty bundles remain present.
 */
export function mergeSemanticFactBundles(
  bundles: readonly (SemanticFactBundle | undefined)[],
  limits: SemanticFactLimits = DEFAULT_SEMANTIC_FACT_LIMITS,
): SemanticFactBundle | undefined {
  const present = bundles.filter((b): b is SemanticFactBundle => b !== undefined);
  if (present.length === 0) return undefined;

  const declMap = new Map<string, DeclarationFact>();
  const refMap = new Map<string, CrossFileReferenceFact>();
  for (const b of present) {
    for (const d of b.declarations) declMap.set(d.declarationId, d);
    for (const r of b.references) refMap.set(r.referenceId, r);
  }
  const coverage = mergeProducerCoverage(present.map((b) => b.coverage));
  return applySemanticFactCaps([...declMap.values()], [...refMap.values()], coverage, limits);
}

/**
 * Incremental merge: keep cached facts whose source (and for references,
 * target declaration) files are outside the re-walked closure; replace with
 * freshly collected facts for the closure. Absent cached + absent fresh →
 * absent; present empty preserved.
 */
export function mergeSemanticFactsIncremental(
  cached: SemanticFactBundle | undefined,
  fresh: SemanticFactBundle | undefined,
  closureRel: ReadonlySet<string>,
  declFileById: ReadonlyMap<string, string>,
  limits: SemanticFactLimits = DEFAULT_SEMANTIC_FACT_LIMITS,
): SemanticFactBundle | undefined {
  if (cached === undefined && fresh === undefined) return undefined;
  if (cached === undefined)
    return fresh === undefined
      ? undefined
      : applySemanticFactCaps(fresh.declarations, fresh.references, fresh.coverage, limits);
  if (fresh === undefined) {
    // Closure was re-walked but adapter omitted the plane → drop cached facts
    // whose files are in the closure (they may be stale) and keep the rest.
    return filterBundleOutsideClosure(cached, closureRel, declFileById, limits);
  }

  const keptDecls = cached.declarations.filter((d) => !closureRel.has(d.filePath));
  const keptRefs = cached.references.filter((r) => {
    if (closureRel.has(r.filePath)) return false;
    if (r.targetDeclarationId !== undefined) {
      const targetFile = declFileById.get(r.targetDeclarationId);
      if (targetFile !== undefined && closureRel.has(targetFile)) return false;
    }
    return true;
  });

  // Coverage must NOT compound across incremental rebuilds. The exact tier
  // re-walks the WHOLE program each run (graph-typescript collects over
  // program.getSourceFiles()), so `fresh.coverage` already describes the entire
  // project — summing it with the equally whole-project `cached.coverage` would
  // double the inspected*/omitted* counters every rebuild until they cross the
  // validation bound and permanently brick the catalog on read. The cached
  // bundle contributes only its retained (outside-closure) declarations and
  // references here; `fresh.coverage` is the authoritative current-state
  // coverage, and finalizeProducerCoverage re-derives emitted* from the merged
  // arrays. (P2 Phase 3 — fix for compounding coverage brick.)
  return mergeSemanticFactBundles(
    [
      {
        referenceScope: 'cross-file',
        declarations: keptDecls,
        references: keptRefs,
        coverage: mergeProducerCoverage([]),
      },
      fresh,
    ],
    limits,
  );
}

function filterBundleOutsideClosure(
  bundle: SemanticFactBundle,
  closureRel: ReadonlySet<string>,
  declFileById: ReadonlyMap<string, string>,
  limits: SemanticFactLimits,
): SemanticFactBundle {
  const declarations = bundle.declarations.filter((d) => !closureRel.has(d.filePath));
  const references = bundle.references.filter((r) => {
    if (closureRel.has(r.filePath)) return false;
    if (r.targetDeclarationId !== undefined) {
      const targetFile = declFileById.get(r.targetDeclarationId);
      if (targetFile !== undefined && closureRel.has(targetFile)) return false;
    }
    return true;
  });
  return applySemanticFactCaps(declarations, references, bundle.coverage, limits);
}

/** Index declarationId → filePath for incremental target-file filtering. */
export function declarationFileIndex(
  declarations: readonly DeclarationFact[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const d of declarations) map.set(d.declarationId, d.filePath);
  return map;
}

/** Empty supported bundle (exact mode, no facts). */
export function emptySemanticFactBundle(
  coverage: Partial<SemanticFactProducerCoverage> = {},
): SemanticFactBundle {
  return {
    referenceScope: 'cross-file',
    declarations: [],
    references: [],
    coverage: {
      status: coverage.status ?? 'complete',
      inspectedDeclarations: coverage.inspectedDeclarations ?? 0,
      emittedDeclarations: 0,
      omittedDeclarations: coverage.omittedDeclarations ?? 0,
      inspectedReferences: coverage.inspectedReferences ?? 0,
      emittedReferences: 0,
      omittedReferences: coverage.omittedReferences ?? 0,
      reasons: sortReasonCodes(coverage.reasons ?? []),
    },
  };
}
