/**
 * Pure validation for the optional {@link SemanticFactBundle} nested in a
 * catalog JSON payload (P2 MCP audit Phase 3 Task 3.2).
 *
 * Called by {@link CatalogRepo} after SQLite JSON decode and before projection.
 * Producer caps are the primary allocation guard; this rejects malformed /
 * oversized decoded structures fail-closed.
 */

import { isPlainRecord } from '@opensip-cli/core';

import { catalogPayloadError } from '../errors/catalog-payload-error.js';
import {
  DEFAULT_SEMANTIC_FACT_LIMITS,
  MAX_REFERENCES_PER_DECLARATION,
  MAX_SEMANTIC_DECLARATIONS,
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

/** Coverage reason codes come from a small fixed producer vocabulary; bound the
 *  array count so a tampered payload cannot embed an unbounded reasons list. */
const MAX_COVERAGE_REASONS = 64;

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
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
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
 *
 * @throws {Error} When the bundle shape, counts, or nested entries are invalid.
 * @throws {TypeError} When declarations/references are not arrays.
 */
export function validateSemanticFactBundle(
  value: unknown,
  limits: SemanticFactLimits = DEFAULT_SEMANTIC_FACT_LIMITS,
): asserts value is SemanticFactBundle {
  if (!isPlainRecord(value) || !exactKeys(value, BUNDLE_KEYS)) {
    throw catalogPayloadError('semantic-bundle', 'Malformed semanticFacts bundle');
  }
  if (value.referenceScope !== 'cross-file') {
    throw catalogPayloadError('semantic-reference-scope', 'Malformed semanticFacts referenceScope');
  }
  if (!Array.isArray(value.declarations) || !Array.isArray(value.references)) {
    throw new TypeError('Malformed semanticFacts arrays');
  }
  if (value.declarations.length > limits.maxDeclarations) {
    throw catalogPayloadError('semantic-bound-exceeded', 'semanticFacts declarations exceed bound');
  }
  if (value.references.length > limits.maxReferences) {
    throw catalogPayloadError('semantic-bound-exceeded', 'semanticFacts references exceed bound');
  }

  const declById = validateDeclarationEntries(value.declarations, limits);
  validateReferenceEntries(value.references, limits, declById);

  validateCoverage(value.coverage, value.declarations.length, value.references.length);
}

/**
 * Validate each declaration, reject duplicate ids, and index by id.
 *
 * @throws {Error} When a declaration is malformed or declarationIds collide.
 */
function validateDeclarationEntries(
  declarations: readonly unknown[],
  limits: SemanticFactLimits,
): Map<string, DeclarationFact> {
  const declIds = new Set<string>();
  const declById = new Map<string, DeclarationFact>();
  for (const raw of declarations) {
    const decl = validateDeclaration(raw, limits);
    if (declIds.has(decl.declarationId)) {
      throw catalogPayloadError('semantic-duplicate-id', 'Duplicate semanticFacts declarationId');
    }
    declIds.add(decl.declarationId);
    declById.set(decl.declarationId, decl);
  }
  return declById;
}

/**
 * Validate each reference, reject duplicate ids, and enforce the per-declaration cap.
 *
 * @throws {Error} When a reference is malformed, ids collide, or per-declaration caps are exceeded.
 */
function validateReferenceEntries(
  references: readonly unknown[],
  limits: SemanticFactLimits,
  declById: ReadonlyMap<string, DeclarationFact>,
): void {
  const refIds = new Set<string>();
  const perDecl = new Map<string, number>();
  for (const raw of references) {
    const ref = validateReference(raw, limits, declById);
    if (refIds.has(ref.referenceId)) {
      throw catalogPayloadError('semantic-duplicate-id', 'Duplicate semanticFacts referenceId');
    }
    refIds.add(ref.referenceId);
    if (ref.targetDeclarationId !== undefined) {
      const n = (perDecl.get(ref.targetDeclarationId) ?? 0) + 1;
      if (n > Math.max(limits.maxReferencesPerDeclaration, MAX_REFERENCES_PER_DECLARATION)) {
        // Fail closed on a tampered/over-limit plane (the producer already caps
        // this; a decoded catalog exceeding it is malformed). With graceful
        // degradation upstream this drops the optional plane, not the catalog.
        throw catalogPayloadError(
          'semantic-bound-exceeded',
          'semanticFacts references-per-declaration exceed bound',
        );
      }
      perDecl.set(ref.targetDeclarationId, n);
    }
  }
}

/**
 * @throws {Error} When declaration shape or field values are malformed.
 */
function validateDeclaration(raw: unknown, limits: SemanticFactLimits): DeclarationFact {
  if (!isPlainRecord(raw) || !exactKeys(raw, DECL_KEYS)) {
    throw catalogPayloadError('semantic-declaration', 'Malformed semanticFacts declaration');
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
    raw.line < 1 ||
    !isSpanInt(raw.column, limits.maxColumn) ||
    !isSpanInt(raw.endLine, limits.maxLine) ||
    raw.endLine < 1 ||
    !isSpanInt(raw.endColumn, limits.maxColumn) ||
    typeof raw.visibility !== 'string' ||
    !VISIBILITIES.has(raw.visibility as SemanticVisibility) ||
    typeof raw.exportRole !== 'string' ||
    !EXPORT_ROLES.has(raw.exportRole as SemanticExportRole) ||
    typeof raw.inTestFile !== 'boolean' ||
    typeof raw.definedInGenerated !== 'boolean'
  ) {
    throw catalogPayloadError(
      'semantic-declaration-fields',
      'Malformed semanticFacts declaration fields',
    );
  }
  return raw as unknown as DeclarationFact;
}

/**
 * @throws {Error} When reference shape, basis/target consistency, or target identity is invalid.
 */
function validateReference(
  raw: unknown,
  limits: SemanticFactLimits,
  declById: ReadonlyMap<string, DeclarationFact>,
): CrossFileReferenceFact {
  if (!isPlainRecord(raw) || !exactKeys(raw, REF_KEYS)) {
    throw catalogPayloadError('semantic-reference', 'Malformed semanticFacts reference');
  }
  if (
    !isSafeText(raw.referenceId, limits.maxText) ||
    typeof raw.kind !== 'string' ||
    !REFERENCE_KINDS.has(raw.kind as ReferenceKind) ||
    !isSafeText(raw.filePath, limits.maxText) ||
    !isSpanInt(raw.line, limits.maxLine) ||
    raw.line < 1 ||
    !isSpanInt(raw.column, limits.maxColumn) ||
    !isSpanInt(raw.endLine, limits.maxLine) ||
    raw.endLine < 1 ||
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
    throw catalogPayloadError(
      'semantic-reference-fields',
      'Malformed semanticFacts reference fields',
    );
  }

  const targetId = raw.targetDeclarationId as string | undefined;
  const basis = raw.basis as SemanticResolutionBasis;

  // Unresolved/external/ambiguous cannot carry a target id.
  if (
    targetId !== undefined &&
    (basis === 'unresolved' || basis === 'external' || basis === 'ambiguous')
  ) {
    throw catalogPayloadError(
      'semantic-inconsistent',
      'semanticFacts reference target id inconsistent with basis',
    );
  }

  if (targetId !== undefined) {
    const decl = declById.get(targetId);
    if (decl === undefined) {
      throw catalogPayloadError(
        'semantic-inconsistent',
        'semanticFacts dangling targetDeclarationId',
      );
    }
    if (
      (raw.targetPackage !== undefined && raw.targetPackage !== decl.package) ||
      (raw.targetName !== undefined && raw.targetName !== decl.name) ||
      (raw.targetKind !== undefined && raw.targetKind !== decl.kind)
    ) {
      throw catalogPayloadError('semantic-inconsistent', 'semanticFacts target identity mismatch');
    }
  }

  return raw as unknown as CrossFileReferenceFact;
}

/**
 * @throws {Error} When coverage shape, status, counters, or reasons are invalid.
 */
function validateCoverage(raw: unknown, declCount: number, refCount: number): void {
  if (!isPlainRecord(raw) || !exactKeys(raw, COVERAGE_KEYS)) {
    throw catalogPayloadError('semantic-coverage', 'Malformed semanticFacts coverage');
  }
  if (raw.status !== 'complete' && raw.status !== 'partial') {
    throw catalogPayloadError(
      'semantic-coverage-status',
      'Malformed semanticFacts coverage status',
    );
  }
  if (
    !isNonNegInt(raw.inspectedDeclarations) ||
    !isNonNegInt(raw.emittedDeclarations) ||
    !isNonNegInt(raw.omittedDeclarations) ||
    !isNonNegInt(raw.inspectedReferences) ||
    !isNonNegInt(raw.emittedReferences) ||
    !isNonNegInt(raw.omittedReferences) ||
    !Array.isArray(raw.reasons) ||
    raw.reasons.length > MAX_COVERAGE_REASONS ||
    !raw.reasons.every((r) => isSafeText(r, MAX_SEMANTIC_TEXT)) ||
    !reasonsSorted(raw.reasons)
  ) {
    throw catalogPayloadError(
      'semantic-coverage-fields',
      'Malformed semanticFacts coverage fields',
    );
  }
  if (raw.emittedDeclarations !== declCount || raw.emittedReferences !== refCount) {
    throw catalogPayloadError(
      'semantic-coverage-counts',
      'semanticFacts coverage counts inconsistent with retained facts',
    );
  }
  // Bound absolute counters so a tampered payload cannot claim unbounded inspection.
  if (
    raw.inspectedDeclarations > MAX_SEMANTIC_DECLARATIONS * 2 ||
    raw.inspectedReferences > MAX_SEMANTIC_REFERENCES * 2
  ) {
    throw catalogPayloadError(
      'semantic-coverage-counters',
      'semanticFacts coverage counters exceed bound',
    );
  }
}
