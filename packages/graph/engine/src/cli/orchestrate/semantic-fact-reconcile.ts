/**
 * Global semantic-fact reconciler (P2 MCP audit Phase 3 Task 3.4).
 *
 * Shard workers build Programs over shard-local files. A reference whose
 * checker target is another workspace package's built `.d.ts` cannot join to
 * that package's SOURCE declaration inside the worker. After fragment merge
 * the global generation has every shard's declarations + the complete
 * {@link PackageManifestIndex}, so unresolved cross-package references finish
 * here — without widening worker Programs or reading source / node_modules.
 *
 * Pure: no filesystem, no compiler nodes, no mutation of shard-fragment rows.
 * Cached local fragments are re-reconciled against the current generation so
 * removed/renamed packages cannot leave stale target IDs.
 */

import { resolveSpecifierToPackage } from '../../cross-package/export-index.js';
import { packageGroupOf } from '../../cross-package/package-group.js';
import { applySemanticFactCaps, makeReferenceId, sortReasonCodes } from '../../semantic-facts.js';
import { DEFAULT_SEMANTIC_FACT_LIMITS } from '../../types.js';

import type { PackageManifestIndex } from '../../cross-package/export-index.js';
import type {
  CrossFileReferenceFact,
  DeclarationFact,
  DeclarationKind,
  SemanticFactBundle,
  SemanticFactLimits,
} from '../../types.js';

/** Index key: packageGroup | exportSubpath | name | kind */
function exportKey(
  packageGroup: string,
  subpath: string,
  name: string,
  kind: DeclarationKind,
): string {
  return `${packageGroup}\0${subpath}\0${name}\0${kind}`;
}

/**
 * Build a unique exported-declaration index from already-captured project
 * declarations. Ambiguous (package, subpath, name, kind) keys are tombstoned
 * so lookup declines rather than guessing.
 */
export function buildExportedDeclarationIndex(
  declarations: readonly DeclarationFact[],
  manifestIndex: PackageManifestIndex,
): {
  readonly unique: ReadonlyMap<string, DeclarationFact>;
  readonly ambiguous: ReadonlySet<string>;
} {
  const unique = new Map<string, DeclarationFact>();
  const ambiguous = new Set<string>();
  for (const decl of declarations) {
    // Only the exported surface participates in cross-package joins.
    if (
      decl.exportRole !== 'named-export' &&
      decl.exportRole !== 'default-export' &&
      decl.exportRole !== 're-export'
    ) {
      continue;
    }
    const packageGroup = packageGroupOf(decl.filePath, manifestIndex);
    // Root export subpath is always '.' for source-file identity; workers may
    // also leave importSpecifier-only unresolved refs without a subpath.
    const subpath = '.';
    const key = exportKey(packageGroup, subpath, decl.name, decl.kind);
    if (ambiguous.has(key)) continue;
    const existing = unique.get(key);
    if (existing === undefined) {
      unique.set(key, decl);
      continue;
    }
    if (existing.declarationId !== decl.declarationId) {
      unique.delete(key);
      ambiguous.add(key);
    }
  }
  return { unique, ambiguous };
}

/**
 * Reconcile unresolved cross-package references against the merged declaration
 * inventory. References that already carry a `targetDeclarationId` are kept
 * when that id still exists; otherwise they are downgraded. Import-specifier
 * mediated unresolved refs attempt a unique workspace join.
 */
export function reconcileSemanticFacts(
  bundle: SemanticFactBundle | undefined,
  manifestIndex: PackageManifestIndex,
  limits: SemanticFactLimits = DEFAULT_SEMANTIC_FACT_LIMITS,
): SemanticFactBundle | undefined {
  if (bundle === undefined) return undefined;

  const declById = new Map(bundle.declarations.map((d) => [d.declarationId, d] as const));
  const { unique, ambiguous } = buildExportedDeclarationIndex(bundle.declarations, manifestIndex);

  const reasons = [...bundle.coverage.reasons];
  const nextRefs: CrossFileReferenceFact[] = [];

  for (const ref of bundle.references) {
    // Already resolved — revalidate the id still exists in this generation.
    if (ref.targetDeclarationId !== undefined) {
      const target = declById.get(ref.targetDeclarationId);
      if (target !== undefined) {
        nextRefs.push(ref);
        continue;
      }
      nextRefs.push(downgradeRef(ref, 'target-missing-after-merge'));
      reasons.push('target-missing-after-merge');
      continue;
    }

    // Unresolved with an import specifier — attempt workspace join.
    if (
      ref.importSpecifier !== undefined &&
      ref.importSpecifier.length > 0 &&
      (ref.basis === 'unresolved' ||
        ref.basis === 'import-specifier' ||
        ref.basis === 'workspace-export-index')
    ) {
      const joined = tryJoinReference(ref, unique, ambiguous, manifestIndex, reasons);
      nextRefs.push(joined);
      continue;
    }

    nextRefs.push(ref);
  }

  return applySemanticFactCaps(
    bundle.declarations,
    nextRefs,
    {
      ...bundle.coverage,
      status: reasons.length > 0 || bundle.coverage.status === 'partial' ? 'partial' : 'complete',
      reasons: sortReasonCodes(reasons),
    },
    limits,
  );
}

function tryJoinReference(
  ref: CrossFileReferenceFact,
  unique: ReadonlyMap<string, DeclarationFact>,
  ambiguous: ReadonlySet<string>,
  manifestIndex: PackageManifestIndex,
  reasons: string[],
): CrossFileReferenceFact {
  const specifier = ref.importSpecifier;
  if (specifier === undefined) return ref;

  const resolved = resolveSpecifierToPackage(specifier, manifestIndex);
  if (resolved === undefined) {
    // Relative imports or external/unmapped — leave as-is (or external).
    if (specifier.startsWith('.')) return ref;
    return {
      ...ref,
      basis: 'external',
      confidence: 'low',
      reason: ref.reason ?? 'external-or-unmapped-specifier',
    };
  }

  const name = ref.targetName;
  const kind = ref.targetKind;
  if (name === undefined || kind === undefined) {
    reasons.push('cross-package-join-incomplete-descriptor');
    return {
      ...ref,
      basis: 'unresolved',
      confidence: 'low',
      reason: 'cross-package-join-incomplete-descriptor',
    };
  }

  const subpath = resolved.subpath ?? '.';
  // Normalize exports subpath `./x` → match our '.' root key for root, else keep.
  const indexSubpath = subpath === './' || subpath === '.' ? '.' : subpath;
  const key = exportKey(resolved.packageGroup, indexSubpath, name, kind);

  if (ambiguous.has(key)) {
    reasons.push('cross-package-join-ambiguous');
    return {
      ...ref,
      basis: 'ambiguous',
      confidence: 'low',
      targetPackage: resolved.packageGroup,
      reason: 'cross-package-join-ambiguous',
    };
  }

  // Also try root key when subpath-specific miss (source decls are root-keyed).
  const rootKey = exportKey(resolved.packageGroup, '.', name, kind);
  const target = unique.get(key) ?? unique.get(rootKey);
  if (target === undefined) {
    reasons.push('cross-package-join-not-found');
    return {
      ...ref,
      basis: 'unresolved',
      confidence: 'low',
      targetPackage: resolved.packageGroup,
      reason: 'cross-package-join-not-found',
    };
  }

  const joined: CrossFileReferenceFact = {
    ...ref,
    targetDeclarationId: target.declarationId,
    targetPackage: target.package,
    targetName: target.name,
    targetKind: target.kind,
    basis: 'workspace-export-index',
    confidence: 'high',
    reason: undefined,
    referenceId: makeReferenceId({
      filePath: ref.filePath,
      kind: ref.kind,
      line: ref.line,
      column: ref.column,
      targetDeclarationId: target.declarationId,
      targetPackage: target.package,
      targetName: target.name,
    }),
  };
  return joined;
}

function downgradeRef(ref: CrossFileReferenceFact, reason: string): CrossFileReferenceFact {
  return {
    ...ref,
    targetDeclarationId: undefined,
    basis: 'unresolved',
    confidence: 'low',
    reason,
    referenceId: makeReferenceId({
      filePath: ref.filePath,
      kind: ref.kind,
      line: ref.line,
      column: ref.column,
      targetName: ref.targetName,
      targetPackage: ref.targetPackage,
    }),
  };
}
