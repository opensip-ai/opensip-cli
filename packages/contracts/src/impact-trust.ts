/**
 * Shared impact-analysis trust contract.
 *
 * The contract is intentionally pure and tool-neutral: graph computes impact,
 * fitness consumes it for conservative changed-targeting, and suite/review
 * surfaces can project the same verdict without learning graph internals.
 */

export type ImpactTrustCoverage = 'full' | 'partial' | 'unknown';

export type ImpactTrustFallback = 'targeted' | 'full-run';

export type ImpactTrustSource = 'git' | 'files' | 'catalog' | 'impact' | 'suite';

export type ImpactUncertaintyCode =
  | 'git-shallow'
  | 'git-merge-base-unavailable'
  | 'changed-file-deleted'
  | 'changed-file-renamed'
  | 'changed-file-unmatched'
  | 'graph-catalog-unavailable'
  | 'graph-catalog-incomplete'
  | 'graph-catalog-approximate'
  | 'impact-uncertainty-truncated'
  | 'impact-truncated'
  | 'suite-step-unverified';

export interface ImpactUncertainty {
  readonly code: ImpactUncertaintyCode;
  readonly source: ImpactTrustSource;
  readonly message: string;
  readonly filePath?: string;
}

export interface ImpactTrust {
  readonly coverage: ImpactTrustCoverage;
  readonly fallback: ImpactTrustFallback;
  readonly fullyVerified: boolean;
  readonly uncertainties: readonly ImpactUncertainty[];
}

export interface BuildImpactTrustInput {
  readonly uncertainties?: readonly ImpactUncertainty[];
  readonly fallback?: ImpactTrustFallback;
}

export interface ImpactTrustChangedEntryInput {
  readonly path: string;
  readonly status?: string;
  readonly previousPath?: string;
}

export interface ImpactTrustGitWarningInput {
  readonly code: string;
  readonly message: string;
}

export const MAX_IMPACT_UNCERTAINTIES = 50;

function capImpactUncertainties(
  uncertainties: readonly ImpactUncertainty[],
): readonly ImpactUncertainty[] {
  if (uncertainties.length <= MAX_IMPACT_UNCERTAINTIES) return uncertainties;
  const kept = uncertainties.slice(0, MAX_IMPACT_UNCERTAINTIES - 1);
  const omitted = uncertainties.length - kept.length;
  return [
    ...kept,
    {
      code: 'impact-uncertainty-truncated',
      source: 'impact',
      message: `Impact uncertainty list truncated; ${String(omitted)} additional reason(s) omitted.`,
    },
  ];
}

export function buildImpactTrust(input: BuildImpactTrustInput = {}): ImpactTrust {
  const uncertainties = capImpactUncertainties(input.uncertainties ?? []);
  const fallback = input.fallback ?? 'targeted';
  let coverage: ImpactTrustCoverage = 'full';
  if (uncertainties.length > 0) {
    coverage = fallback === 'full-run' ? 'partial' : 'unknown';
  }
  return {
    coverage,
    fallback,
    fullyVerified: coverage === 'full' && fallback === 'targeted',
    uncertainties,
  };
}

export function mergeImpactUncertainties(
  ...groups: readonly (readonly ImpactUncertainty[] | undefined)[]
): readonly ImpactUncertainty[] {
  const byKey = new Map<string, ImpactUncertainty>();
  for (const group of groups) {
    for (const item of group ?? []) {
      const key = `${item.code}|${item.source}|${item.filePath ?? ''}`;
      byKey.set(key, item);
    }
  }
  return [...byKey.values()];
}

export function gitWarningsToImpactUncertainties(
  warnings: readonly ImpactTrustGitWarningInput[] | undefined,
): readonly ImpactUncertainty[] {
  return (warnings ?? [])
    .map((warning): ImpactUncertainty | undefined => {
      if (warning.code === 'git-shallow') {
        return {
          code: 'git-shallow',
          source: 'git',
          message: warning.message,
        };
      }
      if (warning.code === 'git-merge-base-unavailable') {
        return {
          code: 'git-merge-base-unavailable',
          source: 'git',
          message: warning.message,
        };
      }
      return undefined;
    })
    .filter((item): item is ImpactUncertainty => item !== undefined);
}

export function changedEntriesToImpactUncertainties(
  entries: readonly ImpactTrustChangedEntryInput[],
): readonly ImpactUncertainty[] {
  const uncertainties: ImpactUncertainty[] = [];
  for (const entry of entries) {
    if (entry.status === 'deleted') {
      uncertainties.push({
        code: 'changed-file-deleted',
        source: 'git',
        filePath: entry.path,
        message: `Changed file ${entry.path} was deleted; verification must use a broader target set.`,
      });
    } else if (entry.status === 'renamed') {
      uncertainties.push({
        code: 'changed-file-renamed',
        source: 'git',
        filePath: entry.path,
        message: `Changed file ${entry.path} was renamed; verification must account for import path changes.`,
      });
    }
  }
  return uncertainties;
}

export const FULL_IMPACT_TRUST: ImpactTrust = buildImpactTrust();
