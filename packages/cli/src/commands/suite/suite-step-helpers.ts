import { MAX_IMPACT_UNCERTAINTIES } from '@opensip-cli/contracts';

import type {
  ImpactTrust,
  ImpactTrustSource,
  ImpactUncertainty,
  ImpactUncertaintyCode,
  SignalEnvelope,
} from '@opensip-cli/contracts';

class DirectProcessExit extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

const IMPACT_UNCERTAINTY_CODES = new Set<ImpactUncertaintyCode>([
  'git-shallow',
  'git-merge-base-unavailable',
  'changed-file-deleted',
  'changed-file-renamed',
  'changed-file-unmatched',
  'graph-catalog-unavailable',
  'graph-catalog-incomplete',
  'graph-catalog-approximate',
  'impact-uncertainty-truncated',
  'impact-truncated',
  'impact-malformed-row-omitted',
  'suite-step-unverified',
]);
const IMPACT_TRUST_SOURCES = new Set<ImpactTrustSource>([
  'git',
  'files',
  'catalog',
  'impact',
  'suite',
]);

function isImpactUncertaintyCode(value: unknown): value is ImpactUncertaintyCode {
  return typeof value === 'string' && IMPACT_UNCERTAINTY_CODES.has(value as ImpactUncertaintyCode);
}

function isImpactTrustSource(value: unknown): value is ImpactTrustSource {
  return typeof value === 'string' && IMPACT_TRUST_SOURCES.has(value as ImpactTrustSource);
}

function impactUncertainty(value: unknown): ImpactUncertainty | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const candidate = value as Partial<ImpactUncertainty>;
  if (
    !isImpactUncertaintyCode(candidate.code) ||
    !isImpactTrustSource(candidate.source) ||
    typeof candidate.message !== 'string' ||
    (candidate.filePath !== undefined && typeof candidate.filePath !== 'string')
  ) {
    return undefined;
  }
  return Object.freeze({
    code: candidate.code,
    source: candidate.source,
    message: candidate.message,
    ...(candidate.filePath === undefined ? {} : { filePath: candidate.filePath }),
  });
}

function impactTrust(value: unknown): ImpactTrust | undefined {
  try {
    if (value === null || typeof value !== 'object') return undefined;
    const candidate = value as Partial<ImpactTrust>;
    if (
      (candidate.coverage !== 'full' &&
        candidate.coverage !== 'partial' &&
        candidate.coverage !== 'unknown') ||
      (candidate.fallback !== 'targeted' && candidate.fallback !== 'full-run') ||
      typeof candidate.fullyVerified !== 'boolean' ||
      !Array.isArray(candidate.uncertainties) ||
      candidate.uncertainties.length > MAX_IMPACT_UNCERTAINTIES
    ) {
      return undefined;
    }
    const uncertainties: ImpactUncertainty[] = [];
    for (const raw of candidate.uncertainties) {
      const parsed = impactUncertainty(raw);
      if (parsed === undefined) return undefined;
      uncertainties.push(parsed);
    }
    return Object.freeze({
      coverage: candidate.coverage,
      fallback: candidate.fallback,
      fullyVerified: candidate.fullyVerified,
      uncertainties: Object.freeze(uncertainties),
    });
  } catch {
    return undefined;
  }
}

export function verificationFromEnvelope(
  envelope: SignalEnvelope | undefined,
): ImpactTrust | undefined {
  if (envelope === undefined) return undefined;
  const declared = impactTrust(envelope.verification);
  if (declared !== undefined) return declared;
  try {
    for (const signal of envelope.signals) {
      const inherited = impactTrust(signal.metadata.trust);
      if (inherited !== undefined) return inherited;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function withProcessExitGuard(
  fn: () => Promise<number>,
  onDirectExit: (code: number) => void,
): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- process.exit has no `this` contract; identity must be restored after the guard.
  const original = process.exit;
  // @fitness-ignore-next-line throws-documentation -- this private guard intentionally throws a sentinel so direct process.exit calls become suite step exit codes.
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number) => {
    throw new DirectProcessExit(typeof code === 'number' ? code : 0);
  };
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DirectProcessExit) {
      onDirectExit(error.code);
      return error.code;
    }
    throw error;
  } finally {
    (process as unknown as { exit: typeof process.exit }).exit = original;
  }
}
