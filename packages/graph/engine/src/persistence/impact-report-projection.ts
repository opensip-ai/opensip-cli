/**
 * Bounded, persistence-safe projection of `graph impact` evidence for reports.
 *
 * The full machine result remains the authority. This module deliberately
 * stores a lossy display projection inside graph's opaque session payload so
 * report composition never needs to rerun Git or graph traversal.
 */
import { compareCodePoint } from '@opensip-cli/contracts';

import type {
  GraphImpactCatalogIdentity,
  GraphImpactResult,
  ImpactFunction,
  ImpactPackage,
  ImpactTrustCoverage,
  ImpactTrustFallback,
  ImpactUncertaintyCode,
  ImpactTrustSource,
} from '@opensip-cli/contracts';

export const MAX_IMPACT_REPORT_PROJECTION_BYTES = 1_048_576;

const MAX_PATH_LENGTH = 4096;
const MAX_DISPLAY_LENGTH = 512;
const COLLECTION_CAPS = {
  changedFiles: 200,
  changedFunctions: 200,
  impactedFunctions: 500,
  impactedFiles: 500,
  impactedPackages: 100,
  recommendedCommands: 20,
} as const;

export interface GraphImpactReportOmittedCounts {
  readonly changedFiles: number;
  readonly changedFunctions: number;
  readonly impactedFunctions: number;
  readonly impactedFiles: number;
  readonly impactedPackages: number;
  readonly recommendedCommands: number;
}

export interface GraphImpactReportBasis {
  readonly type: GraphImpactResult['basis']['type'];
  readonly source?: 'git';
  readonly ref?: string;
  readonly mergeBase?: string;
  readonly isShallow?: boolean;
  readonly warningCodes: readonly string[];
}

export interface GraphImpactReportUncertainty {
  readonly code: ImpactUncertaintyCode;
  readonly source: ImpactTrustSource;
  readonly message: string;
  readonly filePath?: string;
}

export interface GraphImpactReportTrust {
  readonly coverage: ImpactTrustCoverage;
  readonly fallback: ImpactTrustFallback;
  readonly fullyVerified: boolean;
  readonly uncertainties: readonly GraphImpactReportUncertainty[];
}

export interface GraphImpactReportProjection {
  readonly catalog?: GraphImpactCatalogIdentity;
  readonly basis: GraphImpactReportBasis;
  readonly changedFiles: readonly string[];
  readonly changedFunctions: readonly ImpactFunction[];
  readonly impactedFunctions: readonly ImpactFunction[];
  readonly impactedFiles: readonly string[];
  readonly impactedPackages: readonly ImpactPackage[];
  readonly trust: GraphImpactReportTrust;
  readonly recommendedCommands: readonly string[];
  readonly truncated: boolean;
  readonly omitted: GraphImpactReportOmittedCounts;
  readonly detailTruncated: boolean;
  readonly metadataOmitted: boolean;
}

function hasControl(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

function isSafeDisplay(value: string): boolean {
  return value.length > 0 && value.length <= MAX_DISPLAY_LENGTH && !hasControl(value);
}

function isSafeCatalogBuiltAt(value: string): boolean {
  return (
    value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isSafeCatalogLanguage(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/u.test(value);
}

function isSafeProjectPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes('\\') ||
    hasControl(value)
  ) {
    return false;
  }
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isSafeFunction(value: ImpactFunction): boolean {
  return (
    isSafeDisplay(value.qualifiedName) &&
    isSafeProjectPath(value.filePath) &&
    finiteNonNegative(value.line) &&
    (value.package === undefined || isSafeDisplay(value.package)) &&
    (value.blastScore === undefined || finiteNonNegative(value.blastScore))
  );
}

function compareFunctions(left: ImpactFunction, right: ImpactFunction): number {
  const pathOrder = compareCodePoint(left.filePath, right.filePath);
  if (pathOrder !== 0) return pathOrder;
  if (left.line !== right.line) return left.line - right.line;
  const nameOrder = compareCodePoint(left.qualifiedName, right.qualifiedName);
  if (nameOrder !== 0) return nameOrder;
  return compareCodePoint(left.reason, right.reason);
}

function isSafePackage(value: ImpactPackage): boolean {
  return isSafeDisplay(value.name) && finiteNonNegative(value.functionCount);
}

function boundedCollection<T>(
  values: readonly T[],
  cap: number,
  isSafe: (value: T) => boolean,
  compare: (left: T, right: T) => number,
): { readonly retained: readonly T[]; readonly omitted: number } {
  const safe = values.filter(isSafe).sort(compare);
  return {
    retained: safe.slice(0, cap),
    omitted: values.length - Math.min(safe.length, cap),
  };
}

function boundedPathCollection(
  values: readonly string[],
  cap: number,
): { readonly retained: readonly string[]; readonly omitted: number } {
  return boundedCollection(values, cap, isSafeProjectPath, compareCodePoint);
}

function boundedDisplayCollection(
  values: readonly string[],
  cap: number,
): { readonly retained: readonly string[]; readonly omitted: number } {
  return boundedCollection(values, cap, isSafeDisplay, compareCodePoint);
}

function boundedOptionalDisplay(value: string | undefined): {
  readonly value?: string;
  readonly omitted: boolean;
} {
  if (value === undefined) return { omitted: false };
  if (!isSafeDisplay(value)) return { omitted: true };
  return { value, omitted: false };
}

function projectBasis(result: GraphImpactResult): {
  readonly basis: GraphImpactReportBasis;
  readonly metadataOmitted: boolean;
} {
  if (result.basis.type === 'files') {
    return {
      basis: { type: 'files', warningCodes: [] },
      metadataOmitted: false,
    };
  }
  const ref = boundedOptionalDisplay(result.basis.ref);
  const mergeBase = boundedOptionalDisplay(result.basis.mergeBase);
  const warningCodes = (result.basis.warnings ?? [])
    .map((warning) => warning.code)
    .filter(isSafeDisplay)
    .sort(compareCodePoint);
  return {
    basis: {
      type: 'changed',
      source: 'git',
      ...(ref.value === undefined ? {} : { ref: ref.value }),
      ...(mergeBase.value === undefined ? {} : { mergeBase: mergeBase.value }),
      ...(result.basis.isShallow === undefined ? {} : { isShallow: result.basis.isShallow }),
      warningCodes,
    },
    metadataOmitted:
      ref.omitted ||
      mergeBase.omitted ||
      warningCodes.length !== (result.basis.warnings ?? []).length,
  };
}

function projectTrust(result: GraphImpactResult): {
  readonly trust: GraphImpactReportTrust;
  readonly detailTruncated: boolean;
  readonly metadataOmitted: boolean;
} {
  let detailTruncated = false;
  let metadataOmitted = false;
  const uncertainties = result.trust.uncertainties.map((uncertainty) => {
    const filePathIsSafe =
      uncertainty.filePath === undefined || isSafeProjectPath(uncertainty.filePath);
    // Impact uncertainty messages commonly interpolate filePath. When that
    // structured path is rejected, retaining the free-form message would leak
    // the same absolute/outside-root path through a second field.
    const displayMessage = filePathIsSafe
      ? uncertainty.message
      : 'Path-specific uncertainty detail omitted because the path is not project-relative.';
    const message =
      displayMessage.length > MAX_DISPLAY_LENGTH
        ? displayMessage.slice(0, MAX_DISPLAY_LENGTH)
        : displayMessage;
    if (message !== uncertainty.message) detailTruncated = true;
    const safeMessage = hasControl(message) ? message.replaceAll(/\p{Cc}/gu, ' ') : message;
    if (safeMessage !== message) detailTruncated = true;
    const filePath = filePathIsSafe ? uncertainty.filePath : undefined;
    if (uncertainty.filePath !== undefined && filePath === undefined) metadataOmitted = true;
    return {
      code: uncertainty.code,
      source: uncertainty.source,
      message: safeMessage,
      ...(filePath === undefined ? {} : { filePath }),
    };
  });
  return {
    trust: {
      coverage: result.trust.coverage,
      fallback: result.trust.fallback,
      fullyVerified: result.trust.fullyVerified,
      uncertainties,
    },
    detailTruncated,
    metadataOmitted,
  };
}

/** Project the full impact result to fixed per-collection report bounds. */
export function projectImpactForReport(result: GraphImpactResult): GraphImpactReportProjection {
  const changedFiles = boundedPathCollection(result.changedFiles, COLLECTION_CAPS.changedFiles);
  const changedFunctions = boundedCollection(
    result.changedFunctions,
    COLLECTION_CAPS.changedFunctions,
    isSafeFunction,
    compareFunctions,
  );
  const impactedFunctions = boundedCollection(
    result.impactedFunctions,
    COLLECTION_CAPS.impactedFunctions,
    isSafeFunction,
    compareFunctions,
  );
  const impactedFiles = boundedPathCollection(result.impactedFiles, COLLECTION_CAPS.impactedFiles);
  const impactedPackages = boundedCollection(
    result.impactedPackages,
    COLLECTION_CAPS.impactedPackages,
    isSafePackage,
    (left, right) => compareCodePoint(left.name, right.name),
  );
  const recommendedCommands = boundedDisplayCollection(
    result.recommendedCommands,
    COLLECTION_CAPS.recommendedCommands,
  );
  const basis = projectBasis(result);
  const trust = projectTrust(result);
  const omitted = {
    changedFiles: changedFiles.omitted,
    changedFunctions: changedFunctions.omitted,
    impactedFunctions: impactedFunctions.omitted,
    impactedFiles: impactedFiles.omitted,
    impactedPackages: impactedPackages.omitted,
    recommendedCommands: recommendedCommands.omitted,
  };
  const catalogIsSafe =
    result.catalog !== undefined &&
    isSafeCatalogBuiltAt(result.catalog.builtAt) &&
    isSafeCatalogLanguage(result.catalog.language) &&
    /^[a-f0-9]{64}$/u.test(result.catalog.filesFingerprint) &&
    /^[a-f0-9]{64}$/u.test(result.catalog.cacheKeyDigest);
  return {
    ...(catalogIsSafe ? { catalog: result.catalog } : {}),
    basis: basis.basis,
    changedFiles: changedFiles.retained,
    changedFunctions: changedFunctions.retained,
    impactedFunctions: impactedFunctions.retained,
    impactedFiles: impactedFiles.retained,
    impactedPackages: impactedPackages.retained,
    trust: trust.trust,
    recommendedCommands: recommendedCommands.retained,
    truncated: result.truncated,
    omitted,
    detailTruncated: trust.detailTruncated || Object.values(omitted).some((count) => count > 0),
    metadataOmitted:
      basis.metadataOmitted ||
      trust.metadataOmitted ||
      (result.catalog !== undefined && !catalogIsSafe),
  };
}

type ProjectionListKey = keyof Pick<
  GraphImpactReportProjection,
  | 'changedFiles'
  | 'changedFunctions'
  | 'impactedFunctions'
  | 'impactedFiles'
  | 'impactedPackages'
  | 'recommendedCommands'
>;

const BYTE_TRIM_ORDER: readonly ProjectionListKey[] = [
  'recommendedCommands',
  'impactedPackages',
  'impactedFiles',
  'impactedFunctions',
  'changedFunctions',
  'changedFiles',
];

function serializedBytes(value: GraphImpactReportProjection): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function withRetainedPrefix(
  projection: GraphImpactReportProjection,
  key: ProjectionListKey,
  count: number,
): GraphImpactReportProjection {
  const original = projection[key];
  const removed = original.length - count;
  return {
    ...projection,
    [key]: original.slice(0, count),
    omitted: {
      ...projection.omitted,
      [key]: projection.omitted[key] + removed,
    },
    detailTruncated: projection.detailTruncated || removed > 0,
  };
}

function maximumPrefixWithinBudget(
  projection: GraphImpactReportProjection,
  key: ProjectionListKey,
  maxBytes: number,
): number {
  const items = projection[key];
  const n = items.length;
  const baseOmitted = projection.omitted[key];
  // Fixed skeleton + inlined-catalog cost measured ONCE (list emptied); each
  // probe then adds only per-item byte deltas instead of re-stringifying the
  // whole projection per binary-search step. `bytesAt(c)` reproduces
  // serializedBytes(withRetainedPrefix(projection, key, c)) EXACTLY —
  // items + separators are compositional in JSON, and the two fields
  // withRetainedPrefix rewrites (the omitted count's digits and the
  // detailTruncated boolean) are adjusted analytically — so the search
  // converges on the same cut as the whole-stringify probe, byte-identical.
  const emptyBytes = serializedBytes(withRetainedPrefix(projection, key, 0));
  const itemBytes = items.map((item) => Buffer.byteLength(JSON.stringify(item), 'utf8'));
  const prefixBytes: number[] = [0];
  for (const [index, bytes] of itemBytes.entries()) {
    prefixBytes.push((prefixBytes[index] ?? 0) + bytes);
  }
  const boolLen = (value: boolean): number => (value ? 4 : 5);
  const bytesAt = (count: number): number =>
    emptyBytes +
    (prefixBytes[count] ?? 0) +
    Math.max(0, count - 1) +
    (String(baseOmitted + n - count).length - String(baseOmitted + n).length) +
    (boolLen(projection.detailTruncated || n - count > 0) -
      boolLen(projection.detailTruncated || n > 0));
  let low = 0;
  let high = n;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytesAt(middle) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/**
 * Deterministically trim collection tails to a UTF-8 byte budget.
 *
 * Returns `undefined` only when the scalar skeleton itself cannot fit. The
 * caller can then persist the ordinary graph session with an explicit overflow
 * status instead of changing the analysis verdict.
 */
export function fitProjectionToByteBudget(
  projection: GraphImpactReportProjection,
  maxBytes: number,
): GraphImpactReportProjection | undefined {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) return undefined;
  if (serializedBytes(projection) <= maxBytes) return projection;

  let fitted = projection;
  for (const key of BYTE_TRIM_ORDER) {
    if (serializedBytes(fitted) <= maxBytes) return fitted;
    fitted = withRetainedPrefix(fitted, key, maximumPrefixWithinBudget(fitted, key, maxBytes));
  }
  return serializedBytes(fitted) <= maxBytes ? fitted : undefined;
}
