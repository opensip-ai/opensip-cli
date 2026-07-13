import { createHash } from 'node:crypto';

import type {
  ChangeImpactCatalogIdentity,
  ChangeImpactCatalogMatch,
  ChangeImpactEvidence,
  ChangeImpactFunction,
  ChangeImpactPackage,
  ChangeImpactTrust,
  ChangeImpactUncertainty,
} from './types.js';
import type { GraphCatalog } from '@opensip-cli/contracts';

const PATH_LIMIT = 4096;
const DISPLAY_LIMIT = 512;
const CAPS = {
  changedFiles: 200,
  changedFunctions: 200,
  impactedFunctions: 500,
  impactedFiles: 500,
  impactedPackages: 100,
  recommendedCommands: 20,
  uncertainties: 200,
} as const;

export const MISSING_STORED_CATALOG = 'missing-stored';

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function safeDisplay(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= DISPLAY_LIMIT &&
    !/\p{Cc}/u.test(value)
  );
}

function safePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > PATH_LIMIT ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes('\\') ||
    /\p{Cc}/u.test(value)
  ) {
    return false;
  }
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function parsePaths(value: unknown, cap: number): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > cap || !value.every(safePath)) return undefined;
  return value;
}

function parseDisplayList(value: unknown, cap: number): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > cap || !value.every(safeDisplay)) return undefined;
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeCatalogBuiltAt(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function parseCatalog(value: unknown): ChangeImpactCatalogIdentity | undefined {
  const item = record(value);
  if (!item) return undefined;
  const resolutionMode = item.resolutionMode;
  const filesFingerprint = item.filesFingerprint;
  const cacheKeyDigest = item.cacheKeyDigest;
  if (
    !safeCatalogBuiltAt(item.builtAt) ||
    typeof item.language !== 'string' ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/u.test(item.language) ||
    typeof filesFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(filesFingerprint) ||
    typeof cacheKeyDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(cacheKeyDigest) ||
    (resolutionMode !== undefined && resolutionMode !== 'exact' && resolutionMode !== 'fast')
  ) {
    return undefined;
  }
  return {
    builtAt: item.builtAt,
    language: item.language,
    filesFingerprint,
    cacheKeyDigest,
    ...(resolutionMode === undefined ? {} : { resolutionMode }),
  };
}

export function catalogMatch(
  stored: ChangeImpactCatalogIdentity | undefined,
  current: GraphCatalog | null,
): ChangeImpactCatalogMatch {
  if (!stored) return MISSING_STORED_CATALOG;
  if (!current?.cacheKey || !current.filesFingerprint) return 'missing-current';
  const currentMode = current.resolutionMode ?? 'exact';
  const storedMode = stored.resolutionMode ?? 'exact';
  const fingerprintMatches =
    stored.filesFingerprint === current.filesFingerprint ||
    stored.filesFingerprint === sha256(current.filesFingerprint);
  return stored.cacheKeyDigest === sha256(current.cacheKey) &&
    fingerprintMatches &&
    stored.builtAt === current.builtAt &&
    stored.language === current.language &&
    storedMode === currentMode
    ? 'matching'
    : 'mismatched';
}

export type CatalogFunctionIndex = ReadonlyMap<string, readonly string[]>;

function functionIdentity(value: {
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly line: number;
}): string {
  return `${value.qualifiedName}\0${value.filePath}\0${String(value.line)}`;
}

export function buildCatalogFunctionIndex(catalog: GraphCatalog | null): CatalogFunctionIndex {
  const mutable = new Map<string, string[]>();
  if (!catalog) return new Map();
  for (const occurrences of Object.values(catalog.functions)) {
    for (const occurrence of occurrences) {
      if (
        !safeDisplay(occurrence.qualifiedName) ||
        !safePath(occurrence.filePath) ||
        finiteCount(occurrence.line) === undefined ||
        !safeDisplay(occurrence.bodyHash)
      ) {
        continue;
      }
      const key = functionIdentity(occurrence);
      const hashes = mutable.get(key) ?? [];
      hashes.push(occurrence.bodyHash);
      mutable.set(key, hashes);
    }
  }
  return new Map([...mutable].map(([key, hashes]) => [key, [...hashes].sort()] as const));
}

function parseFunction(
  value: unknown,
  match: ChangeImpactCatalogMatch,
  functionIndex: CatalogFunctionIndex,
): ChangeImpactFunction | undefined {
  const item = record(value);
  if (
    !item ||
    !safeDisplay(item.qualifiedName) ||
    !safePath(item.filePath) ||
    finiteCount(item.line) === undefined ||
    !safeDisplay(item.reason) ||
    (item.package !== undefined && !safeDisplay(item.package))
  ) {
    return undefined;
  }
  const base = {
    qualifiedName: item.qualifiedName,
    filePath: item.filePath,
    line: item.line as number,
    reason: item.reason,
    ...(item.package === undefined ? {} : { package: item.package }),
  };
  if (match !== 'matching') return { ...base, navigation: 'catalog-unavailable' };
  const hashes = functionIndex.get(functionIdentity(base)) ?? [];
  if (hashes.length === 0) return { ...base, navigation: 'not-found' };
  if (hashes.length > 1) return { ...base, navigation: 'ambiguous' };
  return { ...base, navigation: 'available', bodyHash: hashes[0] };
}

function parseFunctions(
  value: unknown,
  cap: number,
  match: ChangeImpactCatalogMatch,
  functionIndex: CatalogFunctionIndex,
): readonly ChangeImpactFunction[] | undefined {
  if (!Array.isArray(value) || value.length > cap) return undefined;
  const out = value.map((item) => parseFunction(item, match, functionIndex));
  return out.every((item): item is ChangeImpactFunction => item !== undefined) ? out : undefined;
}

function parsePackages(value: unknown): readonly ChangeImpactPackage[] | undefined {
  if (!Array.isArray(value) || value.length > CAPS.impactedPackages) return undefined;
  const parsed = value.map((entry) => {
    const item = record(entry);
    if (!item || !safeDisplay(item.name) || finiteCount(item.functionCount) === undefined) return;
    return { name: item.name, functionCount: item.functionCount as number };
  });
  return parsed.every((item): item is ChangeImpactPackage => item !== undefined)
    ? parsed
    : undefined;
}

function parseTrust(value: unknown): ChangeImpactTrust | undefined {
  const item = record(value);
  if (!item) return undefined;
  if (item.coverage !== 'full' && item.coverage !== 'partial' && item.coverage !== 'unknown') {
    return undefined;
  }
  if (typeof item.fullyVerified !== 'boolean' || !safeDisplay(item.fallback)) return undefined;
  if (!Array.isArray(item.uncertainties)) return undefined;
  const source = item.uncertainties.slice(0, CAPS.uncertainties);
  const uncertainties = source.map((entry): ChangeImpactUncertainty | undefined => {
    const uncertainty = record(entry);
    if (
      !uncertainty ||
      !safeDisplay(uncertainty.code) ||
      !safeDisplay(uncertainty.source) ||
      !safeDisplay(uncertainty.message) ||
      (uncertainty.filePath !== undefined && !safePath(uncertainty.filePath))
    ) {
      return undefined;
    }
    return {
      code: uncertainty.code,
      source: uncertainty.source,
      message: uncertainty.message,
      ...(uncertainty.filePath === undefined ? {} : { filePath: uncertainty.filePath }),
    };
  });
  if (!uncertainties.every((entry): entry is ChangeImpactUncertainty => entry !== undefined)) {
    return undefined;
  }
  return {
    coverage: item.coverage,
    fallback: item.fallback,
    fullyVerified: item.fullyVerified,
    uncertainties,
  };
}

function parseOmitted(value: unknown): ChangeImpactEvidence['backendOmitted'] | undefined {
  const item = record(value);
  if (!item) return undefined;
  const parsed = {
    changedFiles: finiteCount(item.changedFiles),
    changedFunctions: finiteCount(item.changedFunctions),
    impactedFunctions: finiteCount(item.impactedFunctions),
    impactedFiles: finiteCount(item.impactedFiles),
    impactedPackages: finiteCount(item.impactedPackages),
    recommendedCommands: finiteCount(item.recommendedCommands),
  };
  if (Object.values(parsed).includes(undefined)) return undefined;
  return parsed as ChangeImpactEvidence['backendOmitted'];
}

export function parseEvidence(
  value: unknown,
  current: GraphCatalog | null,
  functionIndex: CatalogFunctionIndex,
): ChangeImpactEvidence | undefined {
  const item = record(value);
  if (!item) return undefined;
  const catalog = item.catalog === undefined ? undefined : parseCatalog(item.catalog);
  if (item.catalog !== undefined && catalog === undefined) return undefined;
  const match = catalogMatch(catalog, current);
  const basis = record(item.basis);
  const basisType = basis?.type;
  const basisRef = basis?.ref;
  const changedFiles = parsePaths(item.changedFiles, CAPS.changedFiles);
  const changedFunctions = parseFunctions(
    item.changedFunctions,
    CAPS.changedFunctions,
    match,
    functionIndex,
  );
  const impactedFunctions = parseFunctions(
    item.impactedFunctions,
    CAPS.impactedFunctions,
    match,
    functionIndex,
  );
  const impactedFiles = parsePaths(item.impactedFiles, CAPS.impactedFiles);
  const impactedPackages = parsePackages(item.impactedPackages);
  const recommendedCommands = parseDisplayList(item.recommendedCommands, CAPS.recommendedCommands);
  const trust = parseTrust(item.trust);
  const backendOmitted = parseOmitted(item.omitted);
  if (
    (basisType !== 'changed' && basisType !== 'files') ||
    (basisRef !== undefined && !safeDisplay(basisRef)) ||
    !changedFiles ||
    !changedFunctions ||
    !impactedFunctions ||
    !impactedFiles ||
    !impactedPackages ||
    !recommendedCommands ||
    !trust ||
    !backendOmitted ||
    typeof item.truncated !== 'boolean' ||
    typeof item.detailTruncated !== 'boolean' ||
    typeof item.metadataOmitted !== 'boolean'
  ) {
    return undefined;
  }
  return {
    ...(catalog === undefined ? {} : { catalog }),
    basisType,
    ...(basisRef === undefined ? {} : { basisRef }),
    changedFiles,
    changedFunctions,
    impactedFunctions,
    impactedFiles,
    impactedPackages,
    trust,
    recommendedCommands,
    truncated: item.truncated,
    backendOmitted,
    detailTruncated: item.detailTruncated,
    metadataOmitted: item.metadataOmitted,
  };
}
