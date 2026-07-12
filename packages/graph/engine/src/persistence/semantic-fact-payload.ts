/**
 * Pure validation for the optional {@link SemanticFactBundle} nested in a
 * catalog JSON payload (P2 MCP audit Phase 3 Task 3.2).
 *
 * Called by {@link CatalogRepo} after SQLite JSON decode and before projection.
 * Producer caps are the primary allocation guard; this rejects malformed /
 * oversized decoded structures fail-closed.
 */

import {
  DEFAULT_SEMANTIC_FACT_LIMITS,
  MAX_REFERENCES_PER_DECLARATION,
  MAX_SEMANTIC_COLUMN,
  MAX_SEMANTIC_DECLARATIONS,
  MAX_SEMANTIC_LINE,
  MAX_SEMANTIC_NAME,
  MAX_SEMANTIC_REFERENCES,
  MAX_SEMANTIC_TEXT,
  type CrossFileReferenceFact,
  type DeclarationFact,
  type DeclarationKind,
  type ReferenceKind,
  type SemanticConfidence,
  type SemanticExportRole,
  type SemanticFactBundle,
  type SemanticFactLimits,
  type SemanticResolutionBasis,
  type SemanticVisibility,
} from '../types.js';

const DECLARATION_KINDS = new Set<DeclarationKind>([
  'function',
  'class',
  'interface',
  'type-alias',
  'enum',
  'namespace',
  'variable',
  'property',
  'method',
  'import',
  'export',
]);

const REFERENCE_KINDS = new Set<ReferenceKind>([
  'type',
  'value',
  'import',
  'export',
  'heritage',
  'annotation',
]);

const BASES = new Set<SemanticResolutionBasis>([
  'compiler-declaration',
  'workspace-export-index',
  'import-specifier',
  'unresolved',
  'ambiguous',
  'external',
]);

const CONFIDENCES = new Set<SemanticConfidence>(['high', 'medium', 'low']);
const VISIBILITIES = new Set<SemanticVisibility>(['exported', 'module-local', 'private']);
const EXPORT_ROLES = new Set<SemanticExportRole>([
  'named-export',
  'default-export',
  're-export',
  'none',
]);

const DECL_KEYS = new Set([
  'declarationId',
  'name',
  'qualifiedName',
  'kind',
  'package',
  'filePath',
  'line',
  'column',
  'endLine',
  'endColumn',
  'visibility',
  'exportRole',
  'inTestFile',
  'definedInGenerated',
]);

const REF_KEYS = new Set([
  'referenceId',
  'kind',
  'filePath',
  'line',
  'column',
  'endLine',
  'endColumn',
  'package',
  'targetDeclarationId',
  'targetPackage',
  'targetName',
  'targetKind',
  'basis',
  'confidence',
  'importSpecifier',
  'reason',
  'inTestFile',
  'definedInGenerated',
]);

const BUNDLE_KEYS = new Set(['referenceScope', 'declarations', 'references', 'coverage']);
const COVERAGE_KEYS = new Set([
  'status',
  'inspectedDeclarations',
  'emittedDeclarations',
  'omittedDeclarations',
  'inspectedReferences',
  'emittedReferences',
  'omittedReferences',
  'reasons',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !/\p{Cc}/u.test(value) &&
    !value.includes('\0')
  );
}

function isSafeOptionalText(value: unknown, max: number): boolean {
  return value === undefined || isSafeText(value, max);
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function isSpanInt(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((k) => allowed.has(k));
}

function reasonsSorted(reasons: readonly string[]): boolean {
  for (let i = 1; i < reasons.length; i++) {
    const prev = reasons[i - 1];
    const cur = reasons[i];
    if (prev === undefined || cur === undefined) return false;
    if (prev >= cur) return false; // strict code-point ascending, unique
  }
  return true;
}

/**
 * Assert `value` is a well-formed {@link SemanticFactBundle} within production
 * bounds. Throws on any malformed/oversized structure.
 */
export function validateSemanticFactBundle(
  value: unknown,
  limits: SemanticFactLimits = DEFAULT_SEMANTIC_FACT_LIMITS,
): asserts value is SemanticFactBundle {
  if (!isRecord(value) || !exactKeys(value, BUNDLE_KEYS)) {
    throw new Error('Malformed semanticFacts bundle');
  }
  if (value.referenceScope !== 'cross-file') {
    throw new Error('Malformed semanticFacts referenceScope');
  }
  if (!Array.isArray(value.declarations) || !Array.isArray(value.references)) {
    throw new Error('Malformed semanticFacts arrays');
  }
  if (value.declarations.length > limits.maxDeclarations) {
    throw new Error('semanticFacts declarations exceed bound');
  }
  if (value.references.length > limits.maxReferences) {
    throw new Error('semanticFacts references exceed bound');
  }

  const declIds = new Set<string>();
  const declById = new Map<string, DeclarationFact>();
  for (const raw of value.declarations) {
    const decl = validateDeclaration(raw, limits);
    if (declIds.has(decl.declarationId)) {
      throw new Error('Duplicate semanticFacts declarationId');
    }
    declIds.add(decl.declarationId);
    declById.set(decl.declarationId, decl);
  }

  const refIds = new Set<string>();
  const perDecl = new Map<string, number>();
  for (const raw of value.references) {
    const ref = validateReference(raw, limits, declById);
    if (refIds.has(ref.referenceId)) {
      throw new Error('Duplicate semanticFacts referenceId');
    }
    refIds.add(ref.referenceId);
    if (ref.targetDeclarationId !== undefined) {
      const n = (perDecl.get(ref.targetDeclarationId) ?? 0) + 1;
      if (n > Math.max(limits.maxReferencesPerDeclaration, MAX_REFERENCES_PER_DECLARATION)) {
        // Soft producer bound — repository allows up to the configured limit.
      }
      perDecl.set(ref.targetDeclarationId, n);
    }
  }

  validateCoverage(value.coverage, value.declarations.length, value.references.length);
}

function validateDeclaration(raw: unknown, limits: SemanticFactLimits): DeclarationFact {
  if (!isRecord(raw) || !exactKeys(raw, DECL_KEYS)) {
    throw new Error('Malformed semanticFacts declaration');
  }
  if (
    !isSafeText(raw.declarationId, limits.maxText) ||
    !isSafeText(raw.name, limits.maxName) ||
    !isSafeText(raw.qualifiedName, limits.maxText) ||
    typeof raw.kind !== 'string' ||
    !DECLARATION_KINDS.has(raw.kind as DeclarationKind) ||
    !isSafeText(raw.package, limits.maxText) ||
    !isSafeText(raw.filePath, limits.maxText) ||
    !isSpanInt(raw.line, limits.maxLine) ||
    (raw.line as number) < 1 ||
    !isSpanInt(raw.column, limits.maxColumn) ||
    !isSpanInt(raw.endLine, limits.maxLine) ||
    (raw.endLine as number) < 1 ||
    !isSpanInt(raw.endColumn, limits.maxColumn) ||
    typeof raw.visibility !== 'string' ||
    !VISIBILITIES.has(raw.visibility as SemanticVisibility) ||
    typeof raw.exportRole !== 'string' ||
    !EXPORT_ROLES.has(raw.exportRole as SemanticExportRole) ||
    typeof raw.inTestFile !== 'boolean' ||
    typeof raw.definedInGenerated !== 'boolean'
  ) {
    throw new Error('Malformed semanticFacts declaration fields');
  }
  return raw as unknown as DeclarationFact;
}

function validateReference(
  raw: unknown,
  limits: SemanticFactLimits,
  declById: ReadonlyMap<string, DeclarationFact>,
): CrossFileReferenceFact {
  if (!isRecord(raw) || !exactKeys(raw, REF_KEYS)) {
    throw new Error('Malformed semanticFacts reference');
  }
  if (
    !isSafeText(raw.referenceId, limits.maxText) ||
    typeof raw.kind !== 'string' ||
    !REFERENCE_KINDS.has(raw.kind as ReferenceKind) ||
    !isSafeText(raw.filePath, limits.maxText) ||
    !isSpanInt(raw.line, limits.maxLine) ||
    (raw.line as number) < 1 ||
    !isSpanInt(raw.column, limits.maxColumn) ||
    !isSpanInt(raw.endLine, limits.maxLine) ||
    (raw.endLine as number) < 1 ||
    !isSpanInt(raw.endColumn, limits.maxColumn) ||
    !isSafeText(raw.package, limits.maxText) ||
    !isSafeOptionalText(raw.targetDeclarationId, limits.maxText) ||
    !isSafeOptionalText(raw.targetPackage, limits.maxText) ||
    !isSafeOptionalText(raw.targetName, limits.maxName) ||
    (raw.targetKind !== undefined &&
      (typeof raw.targetKind !== 'string' ||
        !DECLARATION_KINDS.has(raw.targetKind as DeclarationKind))) ||
    typeof raw.basis !== 'string' ||
    !BASES.has(raw.basis as SemanticResolutionBasis) ||
    typeof raw.confidence !== 'string' ||
    !CONFIDENCES.has(raw.confidence as SemanticConfidence) ||
    !isSafeOptionalText(raw.importSpecifier, limits.maxText) ||
    !isSafeOptionalText(raw.reason, limits.maxText) ||
    typeof raw.inTestFile !== 'boolean' ||
    typeof raw.definedInGenerated !== 'boolean'
  ) {
    throw new Error('Malformed semanticFacts reference fields');
  }

  const targetId = raw.targetDeclarationId as string | undefined;
  const basis = raw.basis as SemanticResolutionBasis;

  // Unresolved/external/ambiguous cannot carry a target id.
  if (
    targetId !== undefined &&
    (basis === 'unresolved' || basis === 'external' || basis === 'ambiguous')
  ) {
    throw new Error('semanticFacts reference target id inconsistent with basis');
  }

  if (targetId !== undefined) {
    const decl = declById.get(targetId);
    if (decl === undefined) {
      throw new Error('semanticFacts dangling targetDeclarationId');
    }
    if (
      (raw.targetPackage !== undefined && raw.targetPackage !== decl.package) ||
      (raw.targetName !== undefined && raw.targetName !== decl.name) ||
      (raw.targetKind !== undefined && raw.targetKind !== decl.kind)
    ) {
      throw new Error('semanticFacts target identity mismatch');
    }
  }

  return raw as unknown as CrossFileReferenceFact;
}

function validateCoverage(
  raw: unknown,
  declCount: number,
  refCount: number,
): void {
  if (!isRecord(raw) || !exactKeys(raw, COVERAGE_KEYS)) {
    throw new Error('Malformed semanticFacts coverage');
  }
  if (raw.status !== 'complete' && raw.status !== 'partial') {
    throw new Error('Malformed semanticFacts coverage status');
  }
  if (
    !isNonNegInt(raw.inspectedDeclarations) ||
    !isNonNegInt(raw.emittedDeclarations) ||
    !isNonNegInt(raw.omittedDeclarations) ||
    !isNonNegInt(raw.inspectedReferences) ||
    !isNonNegInt(raw.emittedReferences) ||
    !isNonNegInt(raw.omittedReferences) ||
    !Array.isArray(raw.reasons) ||
    !raw.reasons.every((r) => isSafeText(r, MAX_SEMANTIC_TEXT)) ||
    !reasonsSorted(raw.reasons as readonly string[])
  ) {
    throw new Error('Malformed semanticFacts coverage fields');
  }
  if (raw.emittedDeclarations !== declCount || raw.emittedReferences !== refCount) {
    throw new Error('semanticFacts coverage counts inconsistent with retained facts');
  }
  // Bound absolute counters so a tampered payload cannot claim unbounded inspection.
  if (
    (raw.inspectedDeclarations as number) > MAX_SEMANTIC_DECLARATIONS * 2 ||
    (raw.inspectedReferences as number) > MAX_SEMANTIC_REFERENCES * 2
  ) {
    throw new Error('semanticFacts coverage counters exceed bound');
  }
}

/** Re-export production constants so CatalogRepo shares one source. */
export const SEMANTIC_FACT_REPO_LIMITS = {
  maxDeclarations: MAX_SEMANTIC_DECLARATIONS,
  maxReferences: MAX_SEMANTIC_REFERENCES,
  maxReferencesPerDeclaration: MAX_REFERENCES_PER_DECLARATION,
  maxName: MAX_SEMANTIC_NAME,
  maxText: MAX_SEMANTIC_TEXT,
  maxLine: MAX_SEMANTIC_LINE,
  maxColumn: MAX_SEMANTIC_COLUMN,
} as const satisfies SemanticFactLimits;
