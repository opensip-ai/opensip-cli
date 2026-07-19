import type {
  ComputeImpactChangedFileEntry,
  ComputeImpactIndex,
  GraphCatalog,
  GraphFunctionOccurrence,
  ImpactFunction,
  ImpactUncertainty,
} from '@opensip-cli/contracts';

export const DEFAULT_MAX_DEPTH = 5;
const HIGH_BLAST_THRESHOLD = 10;
const MAX_IMPACT_PATH_LENGTH = 1024;
const MAX_IMPACT_NAME_LENGTH = 1024;
const MAX_IMPACT_PACKAGE_LENGTH = 214;

function safeText(value: string, maxLength: number): string | undefined {
  return value.length > 0 && value.length <= maxLength && !/\p{Cc}/u.test(value)
    ? value
    : undefined;
}

function safeProjectPath(value: string): string | undefined {
  const normalized = value.replaceAll('\\', '/');
  if (
    safeText(normalized, MAX_IMPACT_PATH_LENGTH) === undefined ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    return;
  }
  return normalized.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
    ? normalized
    : undefined;
}

function derivePackage(occurrence: GraphFunctionOccurrence, filePath: string): string | undefined {
  if (occurrence.package !== undefined) return occurrence.package;
  const segment = filePath.split('/')[0];
  return segment ?? 'root';
}

export function toImpactFunction(
  occurrence: GraphFunctionOccurrence,
  reason: ImpactFunction['reason'],
  catalog: GraphCatalog,
): ImpactFunction | undefined {
  const qualifiedName = safeText(occurrence.qualifiedName, MAX_IMPACT_NAME_LENGTH);
  const filePath = safeProjectPath(occurrence.filePath);
  if (qualifiedName === undefined || filePath === undefined) return;
  const packageName = derivePackage(occurrence, filePath);
  if (
    packageName === undefined ||
    safeText(packageName, MAX_IMPACT_PACKAGE_LENGTH) === undefined ||
    !Number.isSafeInteger(occurrence.line) ||
    occurrence.line < 0
  ) {
    return;
  }
  const features = catalog.features?.function?.[occurrence.bodyHash];
  const featureBlastScore = features?.blast?.score;
  return {
    qualifiedName,
    filePath,
    line: occurrence.line,
    package: packageName,
    ...(featureBlastScore !== undefined && Number.isFinite(featureBlastScore)
      ? { blastScore: featureBlastScore }
      : {}),
    ...(typeof features?.testReachable === 'boolean'
      ? { testReachable: features.testReachable }
      : {}),
    reason,
  };
}

function blastScore(catalog: GraphCatalog, bodyHash: string): number | undefined {
  const score = catalog.features?.function?.[bodyHash]?.blast?.score;
  return typeof score === 'number' && Number.isFinite(score) ? score : undefined;
}

function isTestGap(catalog: GraphCatalog, bodyHash: string): boolean {
  const features = catalog.features?.function?.[bodyHash];
  return features?.reachableOnlyFromTests === true || features?.testReachable === false;
}

export function impactReason(catalog: GraphCatalog, bodyHash: string): ImpactFunction['reason'] {
  const score = blastScore(catalog, bodyHash);
  if (score !== undefined && score >= HIGH_BLAST_THRESHOLD) return 'blast';
  if (isTestGap(catalog, bodyHash)) return 'test-gap';
  return 'caller';
}

export function compareImpactText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function impactResultLimit(top: number | undefined): number | undefined {
  if (top === undefined || top < 0) return;
  if (!Number.isFinite(top)) return 0;
  return Math.max(0, Math.trunc(top));
}

export function catalogUncertainties(
  catalog: GraphCatalog,
  index: Pick<ComputeImpactIndex, 'catalogApproximate'>,
): ImpactUncertainty[] {
  const uncertainties: ImpactUncertainty[] = [];
  if (!catalog.cacheKey || !catalog.filesFingerprint) {
    uncertainties.push({
      code: 'graph-catalog-incomplete',
      source: 'catalog',
      message: 'Graph catalog is missing cache freshness metadata.',
    });
  }
  if (index.catalogApproximate) {
    uncertainties.push({
      code: 'graph-catalog-approximate',
      source: 'catalog',
      message: 'Graph catalog contains approximate call resolution.',
    });
  }
  return uncertainties;
}

export function changedFileEntryUncertainties(
  index: Pick<ComputeImpactIndex, 'catalogFiles'>,
  changedFiles: readonly string[],
  entries: readonly ComputeImpactChangedFileEntry[] | undefined,
): ImpactUncertainty[] {
  const normalizedEntries: readonly ComputeImpactChangedFileEntry[] =
    entries === undefined || entries.length === 0
      ? changedFiles.map((path) => ({ path }))
      : entries;
  const uncertainties: ImpactUncertainty[] = [];
  for (const entry of normalizedEntries) {
    const normalizedPath = entry.path.replaceAll('\\', '/');
    if (entry.status === 'deleted') {
      uncertainties.push({
        code: 'changed-file-deleted',
        source: 'git',
        filePath: normalizedPath,
        message: `Changed file ${normalizedPath} was deleted; downstream imports may need a broader run.`,
      });
      continue;
    }
    if (entry.status === 'renamed') {
      uncertainties.push({
        code: 'changed-file-renamed',
        source: 'git',
        filePath: normalizedPath,
        message: `Changed file ${normalizedPath} was renamed; import edges may have shifted.`,
      });
    }
    if (!index.catalogFiles.has(normalizedPath)) {
      uncertainties.push({
        code: 'changed-file-unmatched',
        source: 'impact',
        filePath: normalizedPath,
        message: `Changed file ${normalizedPath} is not represented in the graph catalog.`,
      });
    }
  }
  return uncertainties;
}

export function remainingImpactLimit(
  resultLimit: number | undefined,
  changedCount: number,
): number | undefined {
  return resultLimit === undefined ? undefined : Math.max(0, resultLimit - changedCount);
}

export function malformedImpactUncertainty(
  omitted: boolean,
): readonly ImpactUncertainty[] | undefined {
  if (!omitted) return;
  return [
    {
      code: 'impact-malformed-row-omitted',
      source: 'impact',
      message: 'Impact rows with unsafe or oversized catalog metadata were omitted.',
    },
  ];
}

export function truncatedImpactUncertainty(
  truncated: boolean,
): readonly ImpactUncertainty[] | undefined {
  if (!truncated) return;
  return [
    {
      code: 'impact-truncated',
      source: 'impact',
      message: 'Impact result was truncated by the bounded result-row cap.',
    },
  ];
}
